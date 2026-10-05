import blessed from 'blessed'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import QRCode from 'qrcode'
import { store, type ChatRow, type MessageRow, type ReactionRow } from './db.js'
import { chatName, contactName, thumbPath, jidUser, type ConnState } from './wa.js'
import { reportHerdr, labelHerdr, releaseHerdr } from './herdr.js'
import type { Backend } from './backend.js'
import { waMarkup, esc, colorFor, setTheme, dim, italic, fmtTime, fmtDay, dayKey, truncate, strWidth, wrapTagged, alignRight, visibleWidth, wrapWidth, fold, graphemes, wrapChars } from './format.js'
import { decode, cached, cellSize, halfBlocks, detectImageMode, KittyImages, type Decoded, type ImageMode } from './image.js'
import { logger, uiLog } from './log.js'
import { patchBlessedUnicode } from './unicode.js'
import type { TermCaps } from './term.js'
import { emojify, completeEmoji } from './emoji.js'
import { enableKittyKeyboard } from './kittykeys.js'
import { parseHex, rainbowRing, mix, nearest256, type Rgb } from './rainbow.js'
import { suggest, llmEnabled, type Suggestion } from './llm.js'
import { patchBlessedItalic } from './italic.js'

type Focus = 'picker' | 'messages' | 'input'

/** Uma imagem no painel: pronta (com pixels) ou só reservada, à espera de ser descarregada e descodificada quando ficar visível. */
interface ImageSlot { row: MessageRow; origLine: number; cols: number; rows: number; pad: number; path?: string; d?: Decoded }

/** O que cada terminal guarda em `state`: os seus tabs, o processo que os tem e a última interacção. */
interface TerminalState { tabs: string[]; active: number; pid?: number; lastActive?: number }

function pidAlive(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.charAt(stat.lastIndexOf(')') + 2) !== 'Z'
  } catch { return false }
}

/** Um troço da barra de tabs: a que tab corresponde e onde está o seu × (ou se é o +). */
interface TabSegment { x0: number; x1: number; index: number; closeX0: number; closeX1: number }

const num = (x: unknown): number => x as number

// Campos internos do blessed que a interface usa: as linhas já partidas à largura do painel e os mapas entre
// linha original e linha desenhada (ftor: original→desenhadas, rtof: desenhada→original).
interface ClinesBox extends blessed.Widgets.BoxElement {
  _clines: string[] & { ftor: number[][]; rtof: number[] }
  childBase: number
}

/** Quanto dura o desvanecer do arco-íris depois de a pessoa parar de escrever. */
const FADE_MS = 1500
/** O aviso de mensagem noutra conversa: tempo a aparecer, a ficar e a desaparecer, em milissegundos. */
const NOTICE = { fadeIn: 400, hold: 6000, fadeOut: 800 }

const HELP = 'Tab muda de tab (com texto, aceita a sugestão) · / conversas · Esc fecha · PgUp/PgDn histórico · ↑ ou clique selecciona mensagem, escrever responde, : reage · :fixe: emoji'

// Cores do tema do terminal, nunca assumidas: texto e fundo por omissão e as 16 nomeadas, que o tema garante
// legíveis sobre o seu fundo. Os avisos passageiros são discretos; só a espera do QR e as quebras de ligação se
// destacam. Ligado não se mostra.
const FG = { tab: 'default', badge: 'red', warn: 'yellow', error: 'red' }

/** Cinzento da rampa de 256 cores (232..255, de #080808 a #eeeeee em passos de 10) mais próximo de uma luminosidade. */
function gray256(luma: number): number {
  return 232 + Math.max(0, Math.min(23, Math.round((luma - 8) / 10)))
}

/**
 * O que se tira do fundo real do terminal (OSC 11): se o tema é escuro, e o cinzento do realce da mensagem
 * seleccionada, afastado da luminosidade dele para o lado claro num tema escuro e para o escuro num claro. Sem
 * resposta assume-se escuro e o realce fica num cinzento médio, legível com texto claro ou escuro.
 */
function theme(bg: string | null): { dark: boolean; selected: number } {
  const m = bg && /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(bg)
  if (!m) return { dark: true, selected: 240 }
  const luma = 0.299 * parseInt(m[1]!, 16) + 0.587 * parseInt(m[2]!, 16) + 0.114 * parseInt(m[3]!, 16)
  const dark = luma < 128
  return { dark, selected: gray256(luma + (dark ? 48 : -48)) }
}

/**
 * Uma tecla aplicada a um texto com cursor (em grafemas): setas, Home/End, Backspace/Delete, Ctrl-U (tudo),
 * Shift+Backspace (palavra anterior, só em terminais com o protocolo de teclado do Kitty) e caracteres escritos,
 * inseridos no cursor, com :códigos: e smileys trocados pelo emoji assim que ficam completos. Devolve null se a tecla
 * não é de edição.
 */
function edit(value: string, cursor: number, k: string, ch: string, key: blessed.Widgets.Events.IKeyEventArg): { value: string; cursor: number } | null {
  const chars = graphemes(value)
  const at = Math.min(cursor, chars.length)
  const join = (before: string[], after: string[]) => ({ value: before.join('') + after.join(''), cursor: before.length })
  if (k === 'left') return { value, cursor: Math.max(0, at - 1) }
  if (k === 'right') return { value, cursor: Math.min(chars.length, at + 1) }
  if (k === 'home') return { value, cursor: 0 }
  if (k === 'end') return { value, cursor: chars.length }
  if (k === 'backspace') return join(chars.slice(0, Math.max(0, at - 1)), chars.slice(at))
  if (k === 'delete') return join(chars.slice(0, at), chars.slice(at + 1))
  if (k === 'C-u') return join([], [])
  if (k === 'S-backspace') return join(graphemes(chars.slice(0, at).join('').replace(/\S*\s*$/, '')), chars.slice(at))
  if (ch && !key.ctrl && !key.meta && ch >= ' ' && ch !== '\x7f') {
    // Ao fechar um :código: ou isolar um smiley com espaço/pontuação, o texto é trocado logo pelo emoji.
    const before = chars.slice(0, at).join('') + ch
    return join(graphemes(/[:\s.,!?]/.test(ch) ? emojify(before) : before), chars.slice(at))
  }
  return null
}



export class Ui {
  private screen: blessed.Widgets.Screen
  private tabsBar: blessed.Widgets.BoxElement
  private msgBox: ClinesBox
  private input: blessed.Widgets.BoxElement
  private picker: blessed.Widgets.ListElement
  /** Aviso de mensagem nova noutra conversa: uma linha com fundo, pousada sobre o tab dela na barra. */
  private toast: blessed.Widgets.BoxElement
  /** Sugestões de emoji para o :prefixo antes do cursor: a caixa por cima da escrita, as opções, a escolhida e onde o prefixo começa. */
  private suggest: blessed.Widgets.BoxElement
  private suggestions: { emoji: string; name: string }[] = []
  private suggestIndex = 0
  private suggestStart = 0
  /** Sugestão do modelo local para o texto `text` (continuação ou correcção), pedida 150 ms depois da última tecla e mostrada 4 s. */
  private ghost: { text: string; s: Suggestion } | undefined
  private ghostTimer: NodeJS.Timeout | undefined
  private ghostAbort: AbortController | undefined
  private ghostHide: NodeJS.Timeout | undefined
  /** O texto tal como ficou ao aceitar uma sugestão que acabou numa palavra: a letra seguinte leva um espaço antes. */
  private accepted: string | undefined
  /** O aviso de mensagem noutra conversa e o instante em que começou a aparecer; o relógio anima-o até sumir. */
  private notice: { jid: string; text: string; since: number } | undefined
  private noticeTimer: NodeJS.Timeout | undefined

  private tabs: string[] = []
  private active = -1
  private segments: TabSegment[] = []
  private pickerOpen = false
  private chats: ChatRow[] = []
  private filtered: ChatRow[] = []
  private filter = ''
  private pickerFilterShown: string | undefined
  private focus: Focus = 'input'
  private inputValue = ''
  /** Posição do cursor na escrita e no filtro das conversas, em grafemas. */
  private cursor = 0
  private filterCursor = 0
  /** Disposição da escrita no último desenho, para mapear cliques: linhas de grafemas e a primeira linha visível. */
  private inputLines: string[][] = [[]]
  private inputTop = 0
  private disableKittyKeyboard?: () => void
  private lineMap: (MessageRow | null)[] = []
  /** Mensagens desenhadas, por ordem; a seleccionada (clique ou setas no painel) e a que está a ser respondida ou reagida. */
  private rows: MessageRow[] = []
  private selected: MessageRow | null = null
  private replyTo: MessageRow | null = null
  /** Mensagem minha aberta na escrita para editar (Backspace ou Delete com a linha vazia). */
  private editing: MessageRow | null = null
  /** O que ficou por enviar em cada conversa: mudar de tab troca a escrita, para nada ir para a pessoa errada. */
  private drafts = new Map<string, { value: string; cursor: number }>()
  private reactTo: MessageRow | null = null
  private inputHeader = false
  private images: ImageSlot[] = []
  private mode: ImageMode
  private kitty: KittyImages | undefined
  private connText = 'a ligar…'
  private transient = ''
  private transientTimer: NodeJS.Timeout | undefined
  private atBottom = true
  private renderTimer: NodeJS.Timeout | undefined
  /**
   * Conversas onde alguém está a escrever (null) ou acabou de parar (o instante em que parou, para o arco-íris se
   * desvanecer), e o relógio que redesenha a barra enquanto houver nomes a animar.
   */
  private typing = new Map<string, number | null>()
  private typingTimer: NodeJS.Timeout | undefined
  private ring: Rgb[]
  private fgRgb: Rgb
  private bgRgb: Rgb
  private dirtyTabs = true
  private dirtyMessages = true
  private showingQr = false

  /** Fundo do terminal escuro (decide a cor forte do tab activo e a dos nomes) e cinzento da mensagem seleccionada. */
  private dark: boolean
  private selectedBg: number

  /** `wa ema`: só essa conversa de cada vez. Sem tabs e sem avisos nem estado das outras; o escolhedor troca-a. */
  private get fixed(): boolean { return !!this.wanted }
  /** Linhas ocupadas em baixo: a escrita (2) e a barra de tabs (1), que em conversa única não existe. */
  private get bottom(): number { return this.fixed ? 2 : 3 }

  constructor(private wa: Backend, caps: TermCaps, private wanted?: string) {
    this.mode = detectImageMode(caps.kittyGraphics)
    ;({ dark: this.dark, selected: this.selectedBg } = theme(caps.bg))
    this.ring = rainbowRing(this.dark)
    this.fgRgb = parseHex(caps.fg) ?? (this.dark ? [192, 192, 192] : [48, 48, 48])
    this.bgRgb = parseHex(caps.bg) ?? (this.dark ? [0, 0, 0] : [255, 255, 255])
    setTheme(this.dark)
    patchBlessedUnicode()
    this.screen = blessed.screen({ smartCSR: true, fullUnicode: caps.utf8, title: 'wa', warnings: false })
    patchBlessedItalic(this.screen)
    // Com localização UTF-8 as molduras saem em caracteres de caixa Unicode (─│┌). Sem isto o blessed muda para o
    // conjunto DEC de linhas, que apps de SSH no telemóvel não conhecem e mostram como q, x, l, k.
    if (caps.utf8) (this.screen.program as unknown as { tput: { brokenACS: boolean } }).tput.brokenACS = true
    const program = this.screen.program as unknown as { _write: (s: string) => void }
    if (this.mode === 'kitty') this.kitty = new KittyImages(s => program._write(s))
    // Só com o terminal a confirmar o protocolo: é o que permite distinguir Shift+Backspace para apagar palavras.
    if (caps.kittyKeyboard) this.disableKittyKeyboard = enableKittyKeyboard((this.screen.program as unknown as { input: Parameters<typeof enableKittyKeyboard>[0] }).input, s => program._write(s))
    logger.info({ caps, images: this.mode, dark: this.dark, term: process.env.TERM }, 'terminal')

    // Disposição: mensagens a toda a largura, escrita em duas linhas, e no fundo a barra de tabs com o estado à direita.
    this.tabsBar = blessed.box({
      parent: this.screen, top: '100%-1', left: 0, width: '100%', height: 1, tags: true, mouse: true,
    })
    this.msgBox = blessed.box({
      parent: this.screen, top: 0, left: 0, right: 0, height: `100%-${this.bottom}`, padding: { left: 1, right: 1 },
      tags: true, scrollable: true, alwaysScroll: true, mouse: true,
    }) as ClinesBox
    this.input = blessed.box({
      parent: this.screen, top: `100%-${this.bottom}`, left: 0, right: 0, height: 2, padding: { left: 1, right: 1 },
      tags: true, mouse: true,
    })
    this.picker = blessed.list({
      parent: this.screen, top: 0, left: 0, right: 0, height: `100%-${this.bottom + 1}`, padding: { left: 1, right: 1 }, hidden: true,
      tags: true, keys: true, mouse: true,
      // A conversa seleccionada marca-se como o tab activo: negrito e a cor mais forte do tema, sem inverter.
      style: { selected: { bold: true, fg: this.dark ? 'bright-white' : 'black' } } as unknown as blessed.Widgets.ListElementStyle,
    })
    // Por cima da segunda linha da escrita, encostado ao tab da conversa; criado por último para ficar à frente.
    this.toast = blessed.box({ parent: this.screen, top: `100%-${this.bottom - 1}`, left: 0, width: 1, height: 1, tags: true, hidden: true })
    // Em conversa única a barra sai e as mensagens ganham a linha; o estado vai para a caixa flutuante, à direita.
    if (this.fixed) this.tabsBar.hide()
    // Sugestões de emoji, por cima da escrita e sobre as mensagens, com o fundo do realce para se destacar.
    this.suggest = blessed.box({
      parent: this.screen, top: '100%-4', left: 0, width: 1, height: 1, tags: true, hidden: true, padding: { left: 1, right: 1 }, wrap: false,
      style: { bg: this.selectedBg } as unknown as blessed.Widgets.Types.TStyle,
    })

    // Rato só com cliques e roda (1000) em codificação SGR (1006), em vez do conjunto que o blessed activa para xterm
    // (1000/1002/1003/1005): o relato de movimento (1003) e a codificação UTF-8 (1005) baralham apps de SSH no
    // telemóvel como o Termius, que com 1000+1006 mandam toques como cliques. O blessed desliga à saída o que ficou ligado.
    const mouse = this.screen.program as unknown as { disableMouse: () => void; setMouse: (o: Record<string, boolean>, enable: boolean) => void; _bindMouse: (s: string, buf: Buffer) => void }
    mouse.disableMouse()
    mouse.setMouse({ vt200Mouse: true, sgrMouse: true }, true)
    // O blessed só lê a primeira sequência de rato de cada pacote de bytes, e os terminais mandam a pressão e a largada
    // do botão (ou dois notches da roda) no mesmo pacote: a largada perdia-se e nunca havia clique. Parte-se o pacote em
    // sequências SGR individuais antes de ele as ler.
    const bindMouse = mouse._bindMouse
    mouse._bindMouse = (s, buf) => {
      const parts = s.match(/\x1b\[<\d+;\d+;\d+[mM]|[^\x1b]+|\x1b(?!\[<)[\s\S]*?(?=\x1b\[<|$)/g)
      if (!parts || parts.length <= 1) return bindMouse.call(mouse, s, buf)
      for (const part of parts) bindMouse.call(mouse, part, Buffer.from(part, 'latin1'))
    }
    this.screen.program.hideCursor()
    this.bindEvents()
    this.registerTerminal()
    this.setFocus('input')
    this.drawInput()
    this.drawStatus()
    // `wa paula` abre logo essa conversa: a primeira, da mais recente para trás, cujo nome ou número contém o texto.
    if (this.wanted) {
      const jid = this.findChat(this.wanted)
      if (!jid) { this.quit(`nenhuma conversa com "${this.wanted}"`); return }
      this.openTab(jid)
    }
    this.renderNow()
    // drawStatus já deixou a barra de tabs desenhada, por isso o renderNow acima não passa pelo título nem pelo Herdr.
    this.updateTitle()
  }

  private get current(): string | null {
    return this.tabs[this.active] ?? null
  }

  // ---------- eventos ----------

  private bindEvents() {
    this.bindDiagnostics()
    this.screen.on('keypress', (ch: string, key: blessed.Widgets.Events.IKeyEventArg) => this.onKey(ch, key))
    // A lista do escolhedor tem posição e altura calculadas à mão: com o terminal a mudar de tamanho refaz-se.
    this.screen.on('resize', () => { this.dirtyMessages = true; this.dirtyTabs = true; if (this.pickerOpen) this.refreshPicker(); this.scheduleRender() })
    this.screen.on('render', () => { this.loadVisibleImages(); this.placeImages() })

    // A roda do rato faz scroll de uma linha por notch (de série o blessed salta meio painel, ou duas entradas na lista).
    this.msgBox.removeAllListeners('wheeldown')
    this.msgBox.removeAllListeners('wheelup')
    this.msgBox.on('wheeldown', () => { this.msgBox.scroll(1); this.screen.render() })
    this.msgBox.on('wheelup', () => { this.msgBox.scroll(-1); this.screen.render() })
    this.picker.removeAllListeners('element wheeldown')
    this.picker.removeAllListeners('element wheelup')
    this.picker.on('element wheeldown', () => { this.picker.scroll(1, true); this.screen.render() })
    this.picker.on('element wheelup', () => { this.picker.scroll(-1, true); this.screen.render() })

    this.picker.on('select', (_item, index) => this.pickChat(index))
    // O clique cai no item (filho da lista) e chega como 'element click', já depois do blessed ter movido a selecção.
    this.picker.on('element click', () => this.pickChat((this.picker as unknown as { selected: number }).selected))

    this.tabsBar.on('click', (data: { x: number; y: number }) => {
      const x = data.x - num(this.tabsBar.aleft)
      const seg = this.segments.find(s => x >= s.x0 && x < s.x1)
      uiLog.info({ x, seg }, 'clique na barra de tabs')
      if (!seg) return
      if (x >= seg.closeX0 && x < seg.closeX1) return this.closeTab(seg.index)
      this.activateTab(seg.index)
    })
    // Clicar numa mensagem selecciona-a (e abre o anexo se o clique cair num); fora das mensagens volta à escrita.
    this.msgBox.on('click', (data: { x: number; y: number }) => {
      const line = this.msgBox.childBase + (data.y - num(this.msgBox.atop) - num(this.msgBox.itop))
      const orig = this.msgBox._clines?.rtof?.[line]
      const row = orig != null ? this.lineMap[orig] : null
      if (row) this.select(row)
      else this.setFocus('input')
      if (row?.media_mime) this.openMedia(row)
      this.renderNow()
    })
    this.msgBox.on('scroll', () => this.updateAtBottom())
    // Clicar na escrita põe o cursor na posição clicada (ou no fim da linha, se o clique cair depois do texto).
    this.input.on('click', (data: { x: number; y: number }) => {
      if (!this.pickerOpen) this.setFocus('input')
      {
        const x = data.x - num(this.input.aleft) - num(this.input.ileft) - 2
        const row = this.inputTop + data.y - num(this.input.atop) - num(this.input.itop) - (this.inputHeader ? 1 : 0)
        let pos = 0
        for (let r = 0; r < Math.min(row, this.inputLines.length); r++) pos += this.inputLines[r]!.length
        const line = this.inputLines[row]
        if (line) {
          let col = 0
          for (const ch of line) { const w = visibleWidth(esc(ch)); if (col + w / 2 > x) break; col += w; pos++ }
        }
        if (this.pickerOpen) this.filterCursor = pos
        else this.cursor = pos
        this.drawInput()
      }
      this.screen.render()
    })

    this.wa.on('connection', (state, detail) => this.onConnection(state, detail))
    this.wa.on('chats', () => { this.dirtyTabs = true; if (this.pickerOpen) this.refreshPicker(); this.scheduleRender() })
    this.wa.on('typing', (jid, who) => this.onTyping(jid, who.length > 0))
    this.wa.on('messages', jid => { if (jid === '*' || jid === this.current) this.dirtyMessages = true; this.dirtyTabs = true; this.scheduleRender() })
    this.wa.on('notify', (jid, row) => {
      if (jid === this.current) { this.wa.markRead(jid).catch(e => logger.warn({ e }, 'markRead')); return }
      if (this.fixed) return
      if (this.tabs.includes(jid)) { this.screen.program.bell(); this.notify(jid, row.text || `[${row.type}]`); return }
      // Conversa sem tab: com vários terminais, só o usado mais recentemente abre o tab, e nunca se a conversa já
      // tiver tab noutro terminal vivo.
      if (this.openElsewhere(jid) || !this.isMostRecentTerminal()) return
      this.openTab(jid, false)
      this.screen.program.bell()
      this.notify(jid, row.text || `[${row.type}]`)
    })
    this.wa.on('status', text => this.flash(text))
  }

  /** Regista no wa.log tudo o que chega do terminal e o que a interface faz com isso. */
  private bindDiagnostics() {
    const program = this.screen.program as unknown as { input: NodeJS.ReadStream }
    program.input.on('data', (b: Buffer) => {
      // Só sequências de escape (rato, teclas especiais), nunca o texto escrito.
      if (b[0] === 0x1b) uiLog.info({ raw: JSON.stringify(b.toString('latin1')) }, 'bytes')
    })
    this.screen.on('mouse', (d: { action: string; button?: string; x: number; y: number; shift?: boolean; ctrl?: boolean }) => {
      this.touchActivity()
      uiLog.info({ action: d.action, button: d.button, x: d.x, y: d.y, shift: d.shift, ctrl: d.ctrl }, 'rato')
    })
    const named: [string, blessed.Widgets.BlessedElement][] = [['tabs', this.tabsBar], ['mensagens', this.msgBox], ['escrita', this.input], ['escolhedor', this.picker]]
    for (const [name, w] of named) {
      ;(w as unknown as { on: (ev: string, fn: (el: blessed.Widgets.BlessedElement, d: { action: string; x: number; y: number }) => void) => void })
        .on('element mouse', (el, d) => uiLog.info({ painel: name, filho: el !== w ? el.type : undefined, action: d.action, x: d.x, y: d.y }, 'rato no painel'))
    }
    this.screen.on('keypress', (_ch: string, key: blessed.Widgets.Events.IKeyEventArg) => uiLog.info({ key: key.full, foco: this.focus }, 'tecla'))
    uiLog.info({ modos: 'rato 1000+1006', term: process.env.TERM, program: process.env.TERM_PROGRAM, cols: this.screen.width, rows: this.screen.height }, 'arranque')
  }

  private onConnection(state: ConnState, detail?: string) {
    if (state === 'qr' && this.wa.qr) {
      QRCode.toString(this.wa.qr, { type: 'terminal', small: true }, (err, qr) => {
        if (err) { logger.error({ err }, 'qr'); return }
        this.showingQr = true
        this.msgBox.setContent(['', '  {bold}Ligar o WhatsApp{/bold}', '', '  No telemóvel: WhatsApp › Definições › Dispositivos associados › Associar dispositivo', '', qr].join('\n'))
        this.lineMap = []; this.images = []; this.rows = []; this.selected = null
        this.screen.render()
      })
      this.connText = `{${FG.warn}-fg}● à espera do QR{/${FG.warn}-fg}`
    } else if (state === 'open') {
      this.connText = ''
      this.showingQr = false
      this.dirtyMessages = true
      for (const jid of this.tabs) this.wa.subscribePresence(jid)
      if (Date.now() - this.lastActive < 120000) { this.lastPresenceTouch = Date.now(); this.wa.touchPresence() }
      this.scheduleRender()
    } else if (state === 'closed') {
      this.connText = `{${FG.error}-fg}● ${esc(detail ?? 'desligado')}{/${FG.error}-fg}`
    } else {
      this.connText = `{${FG.warn}-fg}● a ligar…{/${FG.warn}-fg}`
    }
    this.drawStatus()
    this.screen.render()
  }

  /** Alguém começou ou parou de escrever: o arco-íris corre pelo nome do tab e, ao parar, desvanece-se. */
  private onTyping(jid: string, active: boolean) {
    if (active) this.typing.set(jid, null)
    else if (this.typing.has(jid)) this.typing.set(jid, Date.now())
    if (this.typing.size && !this.typingTimer) {
      this.typingTimer = setInterval(() => {
        for (const [j, stopped] of this.typing) if (stopped != null && Date.now() - stopped > FADE_MS) this.typing.delete(j)
        if (!this.typing.size && this.typingTimer) { clearInterval(this.typingTimer); this.typingTimer = undefined }
        this.drawTabs(); this.screen.render()
      }, 40)
    }
    this.drawTabs()
    this.updateTitle()
    this.screen.render()
  }

  /**
   * O nome com o arco-íris: o anel de matizes corre pelas letras (uma volta em ~3 s, a 25 imagens por segundo), e depois de a pessoa
   * parar cada cor mistura-se com a do texto ao longo de FADE_MS, com uma curva suave, até ficar normal.
   */
  private rainbow(name: string, stopped: number | null): string {
    const n = this.ring.length
    const phase = (Date.now() / 1000) * (n / 3)
    const raw = stopped == null ? 0 : Math.min(1, (Date.now() - stopped) / FADE_MS)
    const t = raw * raw * (3 - 2 * raw)
    return graphemes(name).map((g, i) => {
      const c = nearest256(mix(this.ring[Math.floor(phase + i * 1.5) % n]!, this.fgRgb, t))
      return `{${c}-fg}${esc(g)}{/${c}-fg}`
    }).join('')
  }

  private onKey(ch: string, key: blessed.Widgets.Events.IKeyEventArg) {
    this.touchActivity()
    const k = key.full
    // O blessed emite cada Enter duas vezes: um "enter" sintético e logo o "return" verdadeiro. Só o segundo conta;
    // senão, com sugestões abertas, o primeiro aceitava o emoji e o segundo enviava a mensagem.
    if (k === 'enter' && key.sequence === '\r') return
    if (k === 'C-c') return this.quit()
    // ESC fecha, por ordem: a resposta ou reacção em curso, a selecção, o filtro do escolhedor, o escolhedor, o tab
    // activo, o programa.
    if (k === 'escape') {
      if (this.suggestions.length) { this.suggestions = []; this.drawSuggestions(); return this.screen.render() }
      if (this.replyTo || this.reactTo) { this.replyTo = this.reactTo = null; this.drawInput(); return this.screen.render() }
      if (this.editing) { this.editing = null; this.inputValue = ''; this.cursor = 0; this.updateSuggestions(); this.drawInput(); return this.screen.render() }
      if (this.focus === 'messages') { this.setFocus('input'); return this.renderNow() }
      if (this.pickerOpen) {
        if (this.filter) { this.filter = ''; this.filterCursor = 0; this.refreshPicker(); return this.screen.render() }
        // Sem tabs não há para onde voltar: o escolhedor é o único painel, e fechá-lo é sair.
        return this.tabs.length ? this.closePicker() : this.quit()
      }
      if (this.current) return this.closeTab(this.active)
      return this.quit()
    }
    if (k === 'pageup') { this.msgBox.scroll(-(this.innerHeight() - 1)); return this.screen.render() }
    if (k === 'pagedown') { this.msgBox.scroll(this.innerHeight() - 1); return this.screen.render() }
    // Tab circula pelos tabs abertos; com o escolhedor aberto volta ao tab activo. Conversas novas abrem-se com "/".
    // Com texto na escrita, Tab aceita a sugestão à vista: a lista de emojis, ou a do modelo; sem texto, muda de tab.
    if (k === 'tab' && this.focus === 'input' && !this.pickerOpen && this.inputValue) {
      if (this.suggestions.length) return this.acceptSuggestion()
      if (this.ghostShown()) this.acceptGhost()
      return
    }
    if (k === 'tab') {
      if (!this.tabs.length) return
      return this.activateTab(this.pickerOpen ? this.active : (this.active + 1) % this.tabs.length)
    }

    if (this.focus === 'picker') {
      // Escrever com o escolhedor aberto filtra as conversas; setas e Enter são da lista.
      const e = edit(this.filter, this.filterCursor, k, ch, key)
      if (!e) return
      this.filterCursor = e.cursor
      if (e.value !== this.filter) { this.filter = e.value; this.refreshPicker() }
      else this.drawInput()
      return this.screen.render()
    }
    if (this.focus === 'input') {
      // "/" com a escrita vazia abre logo as conversas; o que se escrever a seguir filtra a lista.
      if (ch === '/' && !this.inputValue) return this.openPicker()
      // Com sugestões de emoji abertas, ↑/↓ escolhem e Enter ou Tab aceitam; o resto continua a escrever e refina-as.
      if (this.suggestions.length) {
        if (k === 'up' || k === 'down') {
          this.suggestIndex = (this.suggestIndex + (k === 'up' ? -1 : 1) + this.suggestions.length) % this.suggestions.length
          this.drawSuggestions()
          return this.screen.render()
        }
        if (k === 'enter' || k === 'return') return this.acceptSuggestion()
      }
      if (k === 'enter' || k === 'return') { const v = this.inputValue; this.inputValue = ''; this.cursor = 0; this.stopComposing(); this.updateSuggestions(); this.drawInput(); this.screen.render(); return void this.submit(v) }
      // Logo a seguir a aceitar uma sugestão que acabou numa palavra, uma letra ou algarismo começa palavra nova:
      // entra com um espaço antes. Espaço e pontuação seguem-se directamente.
      if (this.accepted === this.inputValue && this.cursorAtEnd() && ch && /^[\p{L}\p{N}]$/u.test(ch) && !key.ctrl && !key.meta) {
        this.inputValue += ' '
        this.cursor++
      }
      this.accepted = undefined
      const e = edit(this.inputValue, this.cursor, k, ch, key)
      if (!e) { if (k === 'up') this.moveSelection(-1); return }
      if (e.value !== this.inputValue) this.promoteActive()
      this.inputValue = e.value
      this.cursor = e.cursor
      this.noteComposing()
      this.updateSuggestions()
      this.drawInput()
      return this.screen.render()
    }
    if (this.focus === 'messages') {
      if (k === 'up' || k === 'down') return this.moveSelection(k === 'up' ? -1 : 1)
      // Delete ou Backspace sobre uma mensagem minha de texto abre-a na escrita para a corrigir; Enter envia a edição,
      // Esc desiste.
      if ((k === 'delete' || k === 'backspace') && this.selected) return this.editMessage(this.selected)
      // Escrever sobre a seleccionada começa logo a resposta, com o que se escreveu; ":" começa uma reacção, e fica
      // já escrito para se continuar com o :código: do emoji. O cabeçalho da escrita diz a que mensagem.
      if (this.selected && ch && !key.ctrl && !key.meta && ch >= ' ' && ch !== '\x7f') {
        if (ch === ':') { this.reactTo = this.selected; this.replyTo = null } else { this.replyTo = this.selected; this.reactTo = null }
        this.inputValue = ch
        this.cursor = 1
        this.promoteActive()
        this.setFocus('input')
        return this.renderNow()
      }
    }
  }

  // ---------- selecção de mensagens ----------

  private select(row: MessageRow | null) {
    this.selected = row
    this.dirtyMessages = true
    if (row) { if (this.focus !== 'messages') this.setFocus('messages') }
    else if (this.focus === 'messages') this.setFocus('input')
  }

  /** Move a selecção para a mensagem anterior (-1) ou seguinte (+1); sem selecção, ↑ pega na última; ↓ da última volta à escrita. */
  private moveSelection(dir: -1 | 1) {
    if (!this.current || !this.rows.length) return
    const i = this.selected ? this.rows.findIndex(r => r.id === this.selected!.id) : this.rows.length
    const next = i + dir
    this.select(next >= this.rows.length ? null : this.rows[Math.max(0, next)]!)
    this.renderNow()
    if (this.selected) this.scrollToSelected()
    this.screen.render()
  }

  /** Faz scroll ao painel só o bastante para a mensagem seleccionada ficar toda visível. */
  private scrollToSelected() {
    const id = this.selected?.id
    const first = this.lineMap.findIndex(r => r?.id === id)
    if (first < 0) return
    let last = first
    while (last + 1 < this.lineMap.length && this.lineMap[last + 1]?.id === id) last++
    const ftor = this.msgBox._clines?.ftor
    const top = ftor?.[first]?.[0], bottom = ftor?.[last]?.at(-1)
    if (top == null || bottom == null) return
    const base = this.msgBox.childBase, h = this.innerHeight()
    if (top < base) this.msgBox.scrollTo(top)
    else if (bottom >= base + h) this.msgBox.scrollTo(bottom - h + 1)
  }

  /** Põe uma mensagem de texto minha na escrita, para a corrigir e reenviar como edição. */
  private editMessage(row: MessageRow) {
    if (!row.from_me || row.type !== 'text') return this.flash('só podes corrigir mensagens de texto tuas')
    this.editing = row
    this.replyTo = this.reactTo = null
    this.setFocus('input')
    this.inputValue = row.text.replace(/\n\(editada\)$/, '')
    this.cursor = graphemes(this.inputValue).length
    this.updateSuggestions()
    this.drawInput()
    this.renderNow()
  }

  private who(row: MessageRow): string {
    return row.from_me ? 'eu' : row.chat_jid.endsWith('@g.us') ? contactName(row.sender_jid) : chatName(row.chat_jid)
  }

  private snippet(row: MessageRow): string {
    return row.text.split('\n')[0] || `[${row.type}]`
  }

  private async submit(v: string) {
    const text = emojify(v.trim())
    // Reacção em curso: o que se escreveu é o emoji (vazio retira a reacção), e vai para a mensagem escolhida.
    const reactTo = this.reactTo
    if (reactTo) {
      this.reactTo = null
      this.drawInput()
      this.screen.render()
      if (this.wa.state !== 'open') return this.flash('sem ligação ao WhatsApp; espera pelo ● verde')
      // O ":" com que a reacção começa, sozinho, vale o mesmo que nada: retira a reacção.
      const emoji = text === ':' ? '' : text
      try {
        await this.wa.react(reactTo.chat_jid, reactTo.id, emoji)
        if (!emoji) this.flash('reacção retirada')
      } catch (e) {
        logger.error({ e }, 'react')
        this.flash(`erro: ${(e as Error).message}`, 10000)
      }
      return
    }
    // Edição em curso: o texto substitui o da mensagem aberta; vazio não envia nada e a edição fica aberta.
    const editing = this.editing
    if (editing) {
      if (!text) { this.drawInput(); return this.screen.render() }
      this.editing = null
      this.drawInput()
      this.screen.render()
      if (this.wa.state !== 'open') return this.flash('sem ligação ao WhatsApp; espera pelo ● verde')
      try {
        await this.wa.edit(editing.chat_jid, editing.id, text)
      } catch (e) {
        logger.error({ e }, 'edit')
        this.flash(`erro: ${(e as Error).message}`, 10000)
      }
      return
    }
    if (!text) return
    if (text.startsWith('/')) return this.openPicker(text.slice(1).trim())
    if (!this.current) return this.flash('abre primeiro uma conversa ("/")')
    if (this.wa.state !== 'open') return this.flash('sem ligação ao WhatsApp; espera pelo ● verde')
    const jid = this.current
    // Ao enviar, o painel vai para o fundo para mostrar a mensagem nova, mesmo que estivesse a ver o histórico.
    this.atBottom = true
    try {
      if (text.startsWith(':')) return this.flash(`comando desconhecido: ${text.split(' ')[0]}. ${HELP}`, 10000)
      const replyTo = this.replyTo?.chat_jid === jid ? this.replyTo : null
      this.replyTo = null
      this.drawInput()
      this.screen.render()
      await this.wa.send(jid, text, replyTo?.id)
    } catch (e) {
      logger.error({ e }, 'submit')
      this.flash(`erro: ${(e as Error).message}`, 10000)
    }
  }

  // ---------- tabs ----------

  /**
   * Cada terminal tem os seus tabs, guardados em `state` sob o dispositivo do terminal (/dev/pts/N). O registo leva
   * também o pid e a hora da última interacção: é assim que os vários processos sabem, só pela base, que tabs estão
   * abertos noutros terminais vivos e qual foi o terminal usado mais recentemente.
   */
  /** O registo deste terminal na base: só serve para os terminais abertos ao mesmo tempo se coordenarem. */
  private tabsKey(): string {
    return `tabs:pid${process.pid}`
  }

  private lastActive = Date.now()
  private lastActiveSaved = 0
  private lastPresenceTouch = 0
  /** Conversa a que dissemos "a escrever", quando o dissemos, e o prazo para dizer que parámos. */
  private composingJid: string | null = null
  private composingSentAt = 0
  private composingTimer: NodeJS.Timeout | undefined

  /** Começa sempre sem tabs (nada se repõe de execuções anteriores) e limpa os registos de terminais já mortos. */
  private registerTerminal() {
    for (const r of store.listState<TerminalState>('tabs:')) if (!r.value.pid || !pidAlive(r.value.pid)) store.deleteState(r.key)
    this.saveTabs()
  }

  private saveTabs() {
    this.lastActiveSaved = this.lastActive
    store.setState(this.tabsKey(), { tabs: this.tabs, active: this.active, pid: process.pid, lastActive: this.lastActive } satisfies TerminalState)
  }

  /**
   * A escrita mudou: a conversa activa fica a saber que estamos a escrever, repetido de 5 em 5 segundos enquanto
   * continuarmos, e que parámos ao fim de 5 segundos parados, ao enviar, ao apagar tudo ou ao mudar de tab.
   */
  private noteComposing() {
    const jid = this.current
    if (!jid || !this.inputValue || this.pickerOpen) return this.stopComposing()
    const now = Date.now()
    if (jid !== this.composingJid || now - this.composingSentAt > 5000) {
      if (this.composingJid && jid !== this.composingJid) this.wa.setComposing(this.composingJid, false)
      this.wa.setComposing(jid, true)
      this.composingJid = jid
      this.composingSentAt = now
    }
    if (this.composingTimer) clearTimeout(this.composingTimer)
    this.composingTimer = setTimeout(() => this.stopComposing(), 5000)
  }

  private stopComposing() {
    if (this.composingTimer) { clearTimeout(this.composingTimer); this.composingTimer = undefined }
    if (!this.composingJid) return
    this.wa.setComposing(this.composingJid, false)
    this.composingJid = null
  }

  /** Marca este terminal como o usado mais recentemente; grava no máximo de dois em dois segundos. */
  private touchActivity() {
    this.lastActive = Date.now()
    if (this.lastActive - this.lastActiveSaved > 2000) this.saveTabs()
    // Mantém o dispositivo "disponível" enquanto se usa o terminal; de 10 em 10 segundos chega.
    if (this.lastActive - this.lastPresenceTouch > 10000) { this.lastPresenceTouch = this.lastActive; this.wa.touchPresence() }
  }

  /** Registos dos outros terminais cujo processo ainda está vivo. */
  private otherTerminals(): TerminalState[] {
    const mine = this.tabsKey()
    return store.listState<TerminalState>('tabs:').filter(r => r.key !== mine && r.value.pid && pidAlive(r.value.pid)).map(r => r.value)
  }

  private openElsewhere(jid: string): boolean {
    return this.otherTerminals().some(t => t.tabs.includes(jid))
  }

  private isMostRecentTerminal(): boolean {
    return this.otherTerminals().every(t => (t.lastActive ?? 0) <= this.lastActive)
  }

  /** Abre (ou encontra) o tab da conversa; com `activate` passa a ser o activo e a conversa marca-se como lida. */
  private openTab(jid: string, activate = true) {
    let i = this.tabs.indexOf(jid)
    if (i < 0) { this.tabs.push(jid); i = this.tabs.length - 1 }
    uiLog.info({ jid, index: i, activate }, 'abrir tab')
    this.dirtyTabs = true
    if (activate) this.activateTab(i)
    else { this.saveTabs(); this.scheduleRender() }
  }

  /** Activa o tab sem mexer na ordem da barra; é a escrita que o traz para a frente (promoteActive). */
  private activateTab(i: number) {
    const jid = this.tabs[i]
    if (!jid) return
    if (i !== this.active) {
      this.stopComposing()
      const prev = this.current
      this.active = i; this.atBottom = true; this.dirtyMessages = true; this.selected = this.replyTo = this.reactTo = null
      // A correcção de uma mensagem não é rascunho: cai. O resto fica guardado na conversa de onde se sai.
      if (this.editing) { this.editing = null; this.inputValue = ''; this.cursor = 0 }
      this.switchDraft(prev, jid)
    }
    if (this.notice?.jid === jid) this.notice = undefined
    this.dirtyTabs = true
    this.saveTabs()
    this.wa.subscribePresence(jid)
    if (this.pickerOpen) this.closePicker(false)
    this.setFocus('input')
    this.renderNow()
    this.wa.markRead(jid).catch(e => logger.warn({ e }, 'markRead'))
  }

  /** Move o tab activo para a primeira posição, junto da escrita, quando se começa a escrever nele. */
  private promoteActive() {
    if (this.active <= 0 || !this.tabs[this.active]) return
    const [jid] = this.tabs.splice(this.active, 1)
    this.tabs.unshift(jid!)
    this.active = 0
    this.dirtyTabs = true
    this.saveTabs()
    this.drawTabs()
  }

  /** Guarda a escrita como rascunho da conversa de onde se sai e põe na linha o rascunho da conversa para onde se vai. */
  private switchDraft(from: string | null, to: string | null) {
    if (from) {
      if (this.inputValue) this.drafts.set(from, { value: this.inputValue, cursor: this.cursor })
      else this.drafts.delete(from)
    }
    const d = to ? this.drafts.get(to) : undefined
    this.inputValue = d?.value ?? ''
    this.cursor = d?.cursor ?? 0
    this.updateSuggestions()
  }

  /** Fecha o tab; se era o activo passa para o da direita, ou o da esquerda, ou para as "conversas". */
  private closeTab(i: number) {
    const closing = this.tabs[i]
    if (!closing) return
    uiLog.info({ jid: closing, index: i }, 'fechar tab')
    const wasActive = this.active === i
    this.tabs.splice(i, 1)
    if (this.active > i) this.active--
    else if (wasActive) { this.active = Math.min(i, this.tabs.length - 1); this.atBottom = true }
    // O rascunho vai com o tab; se era o activo, a escrita passa a ser a da conversa que fica.
    this.drafts.delete(closing)
    if (wasActive) { this.editing = null; this.switchDraft(null, this.current) }
    this.dirtyTabs = true
    this.dirtyMessages = true
    this.lineMap = []; this.images = []; this.rows = []; this.selected = null
    this.saveTabs()
    // Fechar o último tab é sair: não se volta ao escolhedor.
    if (!this.tabs.length) return this.quit()
    this.renderNow()
    const jid = this.current
    if (jid) this.wa.markRead(jid).catch(e => logger.warn({ e }, 'markRead'))
  }

  private drawTabs() {
    const width = num(this.tabsBar.width)
    const maxName = width
    // Em conversa única não há tab a mostrar: a linha fica só com o estado à direita.
    const tabs = this.fixed ? [] : this.tabs.map((jid, i) => {
      const unread = store.getChat(jid)?.unread ?? 0
      return { jid, i, name: chatName(jid), badge: unread > 0 ? `(${unread})` : '' }
    })
    // Encurtar os nomes para caberem todos, até um mínimo de 6 caracteres; para lá disso a barra corta à direita.
    const close = this.fixed ? '' : ' ×'
    const overhead = (t: { badge: string }) => 1 + (t.badge ? strWidth(t.badge) + 1 : 0) + strWidth(close) + 1
    let nameW = Math.max(...tabs.map(t => strWidth(t.name)), 0)
    const fits = (w: number) => tabs.reduce((sum, t) => sum + Math.min(strWidth(t.name), w) + overhead(t), 0) <= maxName
    while (nameW > 6 && !fits(nameW)) nameW--
    // O tab activo distingue-se só pelo texto: negrito e na cor mais forte do tema; os outros ficam na cor normal.
    const strong = this.dark ? 'bright-white' : 'black'
    let out = '', x = 0
    this.segments = []
    for (const t of tabs) {
      const name = truncate(t.name, nameW)
      const label = this.typing.has(t.jid) ? this.rainbow(name, this.typing.get(t.jid)!) : esc(name)
      const text = ` ${name}${t.badge ? ' ' + t.badge : ''}${close} `
      const w = strWidth(text)
      const closeX0 = close ? x + w - 2 : x + w
      this.segments.push({ x0: x, x1: x + w, index: t.i, closeX0, closeX1: close ? closeX0 + 1 : closeX0 })
      const badge = t.badge ? ` {${FG.badge}-fg}{bold}${t.badge}{/bold}{/${FG.badge}-fg}` : ''
      const closeMark = close ? ` ${dim('×')}` : ''
      out += t.i === this.active && !this.pickerOpen
        ? `{${strong}-fg}{bold} ${label}{/bold}{/${strong}-fg}${badge}${closeMark} `
        : `{${FG.tab}-fg} ${label}{/${FG.tab}-fg}${badge}${closeMark} `
      x += w
    }
    // Estado encostado à direita: a mensagem passageira (amarela) ou a ligação; cortado se não couber.
    // Ligado não se anuncia: só avisos passageiros e os estados que pedem atenção (QR, ligação caída).
    const avail = width - x - 2
    let text = this.transient ? dim(esc(truncate(this.transient, avail))) : this.connText
    if (this.fixed) {
      // Sem tab por onde correr o arco-íris, "a escrever…" corre aqui enquanto a outra pessoa escreve.
      const jid = this.current
      if (!text && jid && this.typing.has(jid)) text = this.rainbow('a escrever…', this.typing.get(jid)!)
      if (!text) return this.toast.hide()
      const w = Math.min(width, visibleWidth(text) + 2)
      this.toast.left = width - w; this.toast.width = w
      this.toast.setContent(` ${text} `)
      return this.toast.show()
    }
    if (avail >= 6 && text) out += ' '.repeat(Math.max(1, width - x - visibleWidth(text) - 1)) + text
    this.tabsBar.setContent(out)
    this.drawNotice(width)
  }

  /**
   * Pousa o aviso sobre o tab da conversa (ou encostado à direita se o tab não estiver à vista), sem o nome dela e
   * sem fundo: o texto emerge do fundo até um tom um pouco abaixo do texto normal, fica, e volta a fundir-se com o
   * fundo. A cor de cada instante é a mistura fundo→texto pela opacidade do momento, quantizada às 256 cores.
   */
  private drawNotice(width: number) {
    const n = this.notice
    if (!n) return this.toast.hide()
    const text = truncate(n.text, Math.max(1, width - 2))
    const w = strWidth(text) + 2
    const seg = this.segments.find(s => this.tabs[s.index] === n.jid)
    const left = Math.max(0, Math.min(seg && seg.x0 < width ? seg.x0 : width, width - w))
    this.toast.left = left
    this.toast.width = Math.min(w, width)
    const c = nearest256(mix(this.bgRgb, this.fgRgb, 0.85 * this.noticeOpacity(n.since)))
    this.toast.setContent(`{${c}-fg} ${esc(text)} {/${c}-fg}`)
    this.toast.show()
  }

  /** Opacidade do aviso (0..1) desde que começou: sobe, fica, desce; curva suave nas duas pontas. */
  private noticeOpacity(since: number): number {
    const t = Date.now() - since
    const ease = (x: number) => x * x * (3 - 2 * x)
    if (t < NOTICE.fadeIn) return ease(t / NOTICE.fadeIn)
    if (t < NOTICE.fadeIn + NOTICE.hold) return 1
    return ease(Math.max(0, 1 - (t - NOTICE.fadeIn - NOTICE.hold) / NOTICE.fadeOut))
  }

  private notify(jid: string, text: string) {
    // Um aviso por cima de outro já visível não volta a emergir: continua opaco com o texto novo.
    const since = this.notice && this.noticeOpacity(this.notice.since) >= 1 ? Date.now() - NOTICE.fadeIn : Date.now()
    this.notice = { jid, text, since }
    if (!this.noticeTimer) {
      this.noticeTimer = setInterval(() => {
        if (this.notice && Date.now() - this.notice.since >= NOTICE.fadeIn + NOTICE.hold + NOTICE.fadeOut) this.notice = undefined
        if (!this.notice && this.noticeTimer) { clearInterval(this.noticeTimer); this.noticeTimer = undefined }
        this.drawStatus(); this.screen.render()
      }, 40)
    }
    this.drawStatus()
    this.screen.render()
  }

  // ---------- escolhedor ----------

  private openPicker(filter = '') {
    this.filter = filter
    this.filterCursor = graphemes(filter).length
    this.pickerOpen = true
    this.dirtyTabs = true
    this.picker.show()
    this.msgBox.hide()
    this.refreshPicker()
    this.setFocus('picker')
    this.renderNow()
  }

  private closePicker(render = true) {
    this.pickerOpen = false
    this.dirtyTabs = true
    this.filter = ''
    this.picker.hide()
    this.msgBox.show()
    this.setFocus('input')
    if (render) this.renderNow()
  }

  private findChat(text: string): string | null {
    const f = fold(text)
    return store.listChats().find(c => fold(chatName(c.jid)).includes(f) || jidUser(c.jid).includes(f))?.jid ?? null
  }

  private pickChat(index: number) {
    const jid = this.filtered[index]?.jid
    uiLog.info({ index, jid }, 'escolher conversa')
    if (!jid) return
    // Em conversa única o escolhedor troca a conversa em vez de juntar um tab; o rascunho da anterior fica guardado.
    const prev = this.fixed ? this.current : null
    this.openTab(jid)
    if (prev && prev !== jid) {
      this.tabs = [jid]; this.active = 0
      this.dirtyTabs = true
      this.saveTabs()
      this.renderNow()
    }
  }

  private refreshPicker() {
    // Manter a selecção na mesma conversa: os eventos do WhatsApp redesenham a lista a toda a hora e repunham-na no topo.
    const selectedJid = this.filtered[(this.picker as unknown as { selected: number }).selected]?.jid
    const sameFilter = this.pickerFilterShown === this.filter
    this.pickerFilterShown = this.filter
    // Mais recentes em baixo, como as mensagens; a selecção por omissão é a última (a mais recente).
    this.chats = store.listChats().filter(c => !c.archived).reverse()
    const f = fold(this.filter)
    this.filtered = f ? this.chats.filter(c => fold(chatName(c.jid)).includes(f) || jidUser(c.jid).includes(f)) : this.chats
    const width = num(this.picker.width) - num(this.picker.iwidth) - 1
    // Nome da pessoa ou grupo à esquerda e um pedaço da última mensagem à direita, como numa lista de conversas.
    const nameW = Math.min(28, Math.max(12, Math.floor(width * 0.35)))
    const items = this.filtered.map(c => {
      const badge = c.unread > 0 ? ` (${c.unread})` : ''
      const open = this.tabs.includes(c.jid) ? ' ·' : ''
      const name = truncate(chatName(c.jid), nameW - strWidth(badge) - strWidth(open) - 1)
      const left = `${c.unread > 0 ? `{bold}${esc(name)}{/bold}{red-fg}${badge}{/red-fg}` : esc(name)}${open}`
      const last = store.lastMessage(c.jid)
      let preview = ''
      if (last) {
        const who = last.from_me ? 'eu: ' : c.is_group ? `${contactName(last.sender_jid).split(' ')[0]}: ` : ''
        const kind: Record<string, string> = { image: 'imagem', video: 'vídeo', gif: 'gif', sticker: 'sticker', document: 'ficheiro', audio: 'áudio', voice: 'voz', location: 'localização', contact: 'contacto', poll: 'sondagem' }
        const body = last.type === 'text' ? last.text.replace(/\s+/g, ' ') : last.type === 'deleted' ? 'mensagem apagada' : `[${kind[last.type] ?? last.type}]${last.text ? ' ' + last.text.replace(/\s+/g, ' ') : ''}`
        preview = truncate(`${fmtTime(last.ts)} ${who}${body}`, width - nameW - 2)
      }
      return `${left}${' '.repeat(Math.max(1, nameW - visibleWidth(left)))}${dim(esc(preview))}`
    })
    this.picker.setItems(items as unknown as string[])
    // Lista encostada ao fundo quando é mais curta que o painel, com uma linha em branco a separá-la do prompt.
    const panel = num(this.screen.height) - this.bottom - 1
    const top = Math.max(0, panel - this.filtered.length)
    this.picker.top = top
    this.picker.height = panel - top
    const keep = sameFilter ? this.filtered.findIndex(c => c.jid === selectedJid) : -1
    this.picker.select(keep >= 0 ? keep : Math.max(0, this.filtered.length - 1))
    this.drawInput()
  }

  // ---------- estado ----------

  private setFocus(f: Focus) {
    uiLog.info({ de: this.focus, para: f }, 'foco')
    this.focus = f
    if (f !== 'messages' && this.selected) { this.selected = null; this.dirtyMessages = true }
    if (f !== 'input' && this.suggestions.length) { this.suggestions = []; this.drawSuggestions() }
    const w = f === 'picker' ? this.picker : f === 'messages' ? this.msgBox : this.input
    w.focus()
    this.drawInput()
    this.drawStatus()
  }

  private flash(text: string, ms = 6000) {
    this.transient = text
    if (this.transientTimer) clearTimeout(this.transientTimer)
    this.transientTimer = setTimeout(() => { this.transient = ''; this.drawStatus(); this.screen.render() }, ms)
    this.drawStatus()
    this.screen.render()
  }

  private scheduleRender() {
    if (this.renderTimer) return
    this.renderTimer = setTimeout(() => { this.renderTimer = undefined; this.renderNow() }, 40)
  }

  private renderNow() {
    if (this.dirtyTabs) { this.dirtyTabs = false; this.drawTabs(); this.updateTitle() }
    if (this.dirtyMessages && !this.showingQr) { this.dirtyMessages = false; if (this.current) this.renderMessages() }
    // Sem tabs (arranque sem nada guardado, ou as conversas a chegar pela primeira vez) abre-se a conversa mais
    // recente; o escolhedor só aparece com "/".
    if (!this.fixed && !this.current && !this.pickerOpen && !this.showingQr) {
      const recent = store.listChats().find(c => !c.archived)
      if (recent) return this.openTab(recent.jid)
    }
    this.screen.render()
  }

  // Título da janela: a conversa activa, com uma bola à frente enquanto houver mensagens por ler em qualquer conversa.
  private titleShown = ''
  private updateTitle() {
    const unread = store.listChats().filter(c => c.unread > 0 && (this.fixed ? c.jid === this.current : !c.archived))
    const title = `${unread.length ? '● ' : ''}${this.current ? chatName(this.current) : 'wa'}`
    if (title !== this.titleShown) { this.titleShown = title; this.screen.title = title }
    // No Herdr o mesmo sinal vai para o estado do agente: alguém a escrever é trabalho em curso, por ler pede atenção.
    labelHerdr(this.current ? chatName(this.current) : null)
    const typing = [...this.typing].filter(([jid, stopped]) => stopped == null && (!this.fixed || jid === this.current)).map(([jid]) => chatName(jid))
    if (typing.length) reportHerdr('working', `${typing.join(', ')} a escrever`)
    else if (unread.length) reportHerdr('blocked', unread.map(c => `${chatName(c.jid)} (${c.unread})`).join(', '))
    else reportHerdr('idle')
  }

  quit(reason?: string) {
    this.kitty?.dispose()
    this.disableKittyKeyboard?.()
    const released = releaseHerdr()
    this.screen.destroy()
    if (reason) process.stderr.write(`${reason}\n`)
    this.wa.stop().catch(() => {})
    store.deleteState(this.tabsKey())
    store.close()
    void released.then(() => process.exit(0))
  }

  private innerHeight(): number {
    return num(this.msgBox.height) - num(this.msgBox.iheight)
  }

  private updateAtBottom() {
    const total = this.msgBox._clines?.length ?? 0
    this.atBottom = this.msgBox.childBase + this.innerHeight() >= total
  }

  // ---------- desenho ----------

  private drawStatus() {
    this.dirtyTabs = true
    this.drawTabs()
    this.dirtyTabs = false
  }

  // ---------- sugestões de emoji ----------

  /** Um `:prefixo` com duas ou mais letras logo antes do cursor abre a lista dos emojis cujo nome começa assim. */
  private updateSuggestions() {
    const chars = graphemes(this.inputValue)
    const at = Math.min(this.cursor, chars.length)
    const m = /(^|[^\w:]):([a-z0-9_+-]{2,})$/i.exec(chars.slice(0, at).join(''))
    const options = m ? completeEmoji(m[2]!).slice(0, 5) : []
    const same = options.length === this.suggestions.length && options.every((o, i) => o.emoji === this.suggestions[i]!.emoji)
    this.suggestions = options
    if (!same) this.suggestIndex = 0
    if (m) this.suggestStart = at - graphemes(`:${m[2]}`).length
    this.drawSuggestions()
    this.scheduleGhost()
  }

  // ---------- sugestões do modelo local ----------

  private cursorAtEnd(): boolean {
    return this.cursor >= graphemes(this.inputValue).length
  }

  /** A sugestão guardada ainda vale para o que está escrito e o cursor está no fim: é a que se mostra e se aceita. */
  private ghostShown(): Suggestion | null {
    const g = this.ghost
    return g && g.text === this.inputValue && !this.pickerOpen && this.cursorAtEnd() ? g.s : null
  }

  /**
   * Pede ao modelo uma sugestão para o texto actual, 150 ms depois da última tecla e só com o cursor no fim, sem
   * reacção em curso nem sugestões de emoji abertas. Um pedido novo cancela o anterior; a resposta só se usa se o
   * texto ainda for o mesmo quando chega, e fica 4 s à vista.
   */
  private scheduleGhost() {
    if (this.ghost && this.ghost.text !== this.inputValue) this.clearGhost()
    if (this.ghostTimer) { clearTimeout(this.ghostTimer); this.ghostTimer = undefined }
    this.ghostAbort?.abort()
    this.ghostAbort = undefined
    const jid = this.current
    if (!llmEnabled || !jid || this.focus !== 'input' || this.pickerOpen || this.reactTo || this.suggestions.length) return
    if (!this.cursorAtEnd() || this.inputValue.trim().length < 3 || this.ghost?.text === this.inputValue) return
    const text = this.inputValue
    this.ghostTimer = setTimeout(() => {
      this.ghostTimer = undefined
      if (text !== this.inputValue) return
      const abort = new AbortController()
      this.ghostAbort = abort
      const context = store.listMessages(jid, 6).filter(r => r.text && r.type !== 'deleted').map(r => ({ who: this.who(r), text: r.text }))
      suggest(context, text, abort.signal).then(s => {
        if (abort.signal.aborted || text !== this.inputValue || !s) return
        this.ghost = { text, s }
        if (this.ghostHide) clearTimeout(this.ghostHide)
        this.ghostHide = setTimeout(() => { if (this.ghost?.text === text) { this.clearGhost(); this.drawInput(); this.screen.render() } }, 4000)
        this.drawInput()
        this.screen.render()
      }, e => { if (!abort.signal.aborted) logger.debug({ e }, 'llm') })
    }, 150)
  }

  private clearGhost() {
    this.ghost = undefined
    if (this.ghostHide) { clearTimeout(this.ghostHide); this.ghostHide = undefined }
  }

  /** O que se mostra: a palavra a meio (as letras que faltam, ou a palavra certa) tem prioridade sobre a correcção atrás. */
  private ghostView(s: Suggestion): { kind: 'suffix' | 'word' | 'fix'; text: string } | null {
    if (s.word) {
      const { from, to } = s.word
      if (to.toLowerCase().startsWith(from.toLowerCase()) && to.length > from.length) return { kind: 'suffix', text: to.slice(from.length) }
      return { kind: 'word', text: to }
    }
    return s.fix ? { kind: 'fix', text: s.fix.to } : null
  }

  private acceptGhost() {
    const s = this.ghostShown()
    const v = s && this.ghostView(s)
    if (!s || !v) return
    if (v.kind === 'fix') {
      const { start, end, to } = s.fix!
      this.inputValue = this.inputValue.slice(0, start) + to + this.inputValue.slice(end)
    } else {
      this.inputValue = this.inputValue.slice(0, this.inputValue.length - s.word!.from.length) + s.word!.to
    }
    this.cursor = graphemes(this.inputValue).length
    this.accepted = /[\p{L}\p{M}\p{N}'-]$/u.test(this.inputValue) ? this.inputValue : undefined
    this.clearGhost()
    this.promoteActive()
    this.updateSuggestions()
    this.drawInput()
    this.screen.render()
  }

  private drawSuggestions() {
    if (!this.suggestions.length) { this.suggest.hide(); return }
    const lines = this.suggestions.map((o, i) => i === this.suggestIndex
      ? `{bold}› ${esc(o.emoji)}  :${esc(o.name)}:{/bold}`
      : `  ${esc(o.emoji)}  :${esc(o.name)}:`)
    // Uma coluna a mais além do padding: o blessed parte a linha se a etiqueta de fecho cair na última coluna.
    this.suggest.width = Math.max(...lines.map(visibleWidth)) + 3
    this.suggest.height = lines.length
    this.suggest.top = `100%-${this.bottom + lines.length}`
    this.suggest.setContent(lines.join('\n'))
    this.suggest.show()
  }

  /** O `:prefixo` dá lugar ao emoji escolhido, seguido de um espaço. */
  private acceptSuggestion() {
    const o = this.suggestions[this.suggestIndex]!
    const chars = graphemes(this.inputValue)
    const at = Math.min(this.cursor, chars.length)
    const before = [...chars.slice(0, this.suggestStart), o.emoji, ' ']
    this.inputValue = before.join('') + chars.slice(at).join('')
    this.cursor = before.length
    this.suggestions = []
    this.drawSuggestions()
    this.drawInput()
    return this.screen.render()
  }

  private drawInput() {
    // Duas linhas, prompt ">" na primeira, texto partido por palavras (nunca a meio de uma) e continuação indentada.
    // Com mais de duas linhas mostram-se as duas à volta do cursor, que fica na de baixo sempre que possível. Com as
    // "conversas" abertas, a mesma linha serve para escrever o filtro. A responder ou a reagir, a primeira
    // linha diz a que mensagem, e sobra uma para o texto.
    const w = num(this.input.width) - num(this.input.iwidth) - 1
    const target = this.pickerOpen ? null : this.replyTo ?? this.reactTo ?? this.editing
    const header = !target ? null : this.editing
      ? `✎ editar: ${this.snippet(target)} · Enter envia, Esc desiste`
      : this.replyTo
        ? `↩ ${this.who(target)}: ${this.snippet(target)}`
        : `reagir a ${this.who(target)}: ${this.snippet(target)} · :código: ou emoji e Enter; Enter vazio retira`
    // Sugestão do modelo, discreta, em itálico cinzento na sequência do texto: as letras que faltam à palavra a meio,
    // coladas ao cursor (que pousa sobre a primeira), ou, três células à frente, a palavra certa a seguir a "⇢", seja a palavra a meio
    // corrigida ou uma palavra errada mais atrás. Tab aceita.
    const ghost = this.ghostShown()
    const view = ghost ? this.ghostView(ghost) : null
    const ghostNext = view?.kind === 'suffix' ? view.text : ''
    const ghostWord = view && view.kind !== 'suffix' ? `   ⇢ ${view.text}` : ''
    this.inputHeader = header != null
    const rowsAvail = header ? 1 : 2
    const width = Math.max(4, w - 2)
    const chars = graphemes(this.pickerOpen ? this.filter : this.inputValue)
    const cursor = Math.min(this.pickerOpen ? this.filterCursor : this.cursor, chars.length)
    const lines = wrapChars(chars, width)
    // Linha e coluna do cursor: no fim do texto fica depois do último grafema, e passa a uma linha nova se não cabe.
    let row = 0, start = 0
    while (row < lines.length - 1 && cursor >= start + lines[row]!.length) start += lines[row++]!.length
    let col = cursor - start
    if (col >= lines[row]!.length && wrapWidth(esc(lines[row]!.join(''))) >= width) { lines.push([]); row++; col = 0 }
    this.inputLines = lines
    this.inputTop = Math.max(0, Math.min(row - (rowsAvail - 1), lines.length - rowsAvail))
    const showCursor = this.focus === 'input' || this.focus === 'picker'
    const render = (line: string[], r: number) => {
      if (!showCursor || r !== row) return esc(line.join(''))
      const before = esc(line.slice(0, col).join(''))
      const avail = width - visibleWidth(esc(line.join(''))) - 1
      if (ghostNext && col >= line.length && avail >= 1) {
        // O cursor fica sobre a primeira letra da sugestão, sem célula vazia pelo meio; o resto segue em itálico.
        const g = graphemes(truncate(ghostNext, avail + 1))
        return before + dim(italic('{inverse}' + esc(g[0]!) + '{/inverse}' + esc(g.slice(1).join(''))))
      }
      const tail = ghostWord && col >= line.length && avail >= 7 ? dim(italic(esc(truncate(ghostWord, avail)))) : ''
      return before + '{inverse}' + esc(line[col] ?? ' ') + '{/inverse}' + esc(line.slice(col + 1).join('')) + tail
    }
    const visible = lines.slice(this.inputTop, this.inputTop + rowsAvail)
    // O prompt diz o que a linha faz: ">" escreve, "/" filtra as conversas.
    const prompt = this.pickerOpen ? '/ ' : '> '
    const out = visible.map((l, i) => (this.inputTop + i === 0 ? prompt : '  ') + render(l, this.inputTop + i))
    if (header) out.unshift(dim(esc(truncate(header, w))))
    this.input.setContent(out.join('\n'))
  }

  private imagePathFor(row: MessageRow): string | null {
    if (row.media_path && /^image\//.test(row.media_mime ?? '') && fs.existsSync(row.media_path)) return row.media_path
    const t = thumbPath(row.chat_jid, row.id)
    return fs.existsSync(t) ? t : null
  }

  private renderMessages() {
    const jid = this.current
    if (!jid) return
    const isGroup = jid.endsWith('@g.us')
    const width = num(this.msgBox.width) - num(this.msgBox.iwidth)
    const lines: string[] = []
    const map: (MessageRow | null)[] = []
    const images: ImageSlot[] = []
    const selectedId = this.selected?.id
    // A seleccionada leva o fundo a toda a largura, seja de quem for: as linhas chegam aqui já partidas à largura do
    // painel, e completam-se com espaços até ao bordo.
    const push = (line: string, row: MessageRow | null) => {
      if (row && row.id === selectedId) line = `{${this.selectedBg}-bg}${line}${' '.repeat(Math.max(0, width - 1 - visibleWidth(line)))}{/${this.selectedBg}-bg}`
      lines.push(line)
      map.push(row)
    }
    const reactions = new Map<string, ReactionRow[]>()
    for (const r of store.listReactions(jid)) reactions.set(r.msg_id, [...(reactions.get(r.msg_id) ?? []), r])
    const rows = store.listMessages(jid)
    this.rows = rows
    this.selected = rows.find(r => r.id === selectedId) ?? null
    let lastDay = ''

    for (const row of rows) {
      const day = dayKey(row.ts)
      if (day !== lastDay) {
        lastDay = day
        const label = `── ${fmtDay(row.ts)} ──`
        push(dim(`${' '.repeat(Math.max(0, Math.floor((width - strWidth(label)) / 2)))}${label}`), null)
      }
      // As minhas mensagens ficam encostadas à direita: parto eu as linhas (o blessed só parte pela esquerda) e
      // encosto cada uma ao bordo; as dos outros ficam à esquerda, partidas da mesma forma.
      const mine = row.from_me === 1
      // Uma coluna de margem à direita: o blessed parte a linha se uma etiqueta de fecho cair na última coluna.
      const out = (line: string, r: MessageRow | null) => {
        for (const l of wrapTagged(line, width - 1)) push(mine ? alignRight(l, width - 1) : l, r)
      }
      const name = mine ? 'eu' : isGroup ? contactName(row.sender_jid) : chatName(jid)
      const color = mine ? 'green' : colorFor(row.sender_jid)
      const ticks = !mine ? '' : (row.status ?? 0) >= 4 ? '{cyan-fg}✓✓{/cyan-fg}' : (row.status ?? 0) >= 3 ? '✓✓' : (row.status ?? 0) >= 2 ? '✓' : dim('○')
      // Nas minhas a hora vem antes do "eu"; nomes sem negrito, só a cor.
      out(mine
        ? `${dim(fmtTime(row.ts))} {${color}-fg}${esc(name)}{/${color}-fg} ${ticks}`
        : `{${color}-fg}${esc(name)}{/${color}-fg} ${dim(fmtTime(row.ts))}`, row)
      if (row.quoted) {
        const [who, text] = row.quoted.split('\t')
        const author = who === this.wa.me ? '' : `${esc(contactName(who ?? ''))}: `
        out(dim(`│ ${author}${esc(truncate(text ?? '', width - 6))}`), row)
      }

      const type = row.type
      const mediaHint = row.media_path ? dim('(clique para abrir)') : row.media_err ? dim('(indisponível)') : dim('(clique para descarregar)')
      if (type === 'deleted') out(dim('⊘ mensagem apagada'), row)
      else if (type === 'image' || type === 'sticker' || type === 'gif' || type === 'video') {
        this.pushImage(row, push, images, lines, width, mine)
        if (type === 'video' || type === 'gif') out(`{magenta-fg}▶ ${type === 'gif' ? 'gif' : 'vídeo'}{/magenta-fg} ${mediaHint}`, row)
      } else if (type === 'document') {
        out(`{yellow-fg}📎 ${esc(row.media_name ?? 'ficheiro')}{/yellow-fg} ${mediaHint}`, row)
      } else if (type === 'audio' || type === 'voice') {
        out(`{yellow-fg}${type === 'voice' ? '🎤' : '🎵'} ${type === 'voice' ? 'mensagem de voz' : 'áudio'} ${esc(row.text)}{/yellow-fg} ${row.media_path ? dim('(clique para ouvir)') : mediaHint}`, row)
      } else if (type === 'location') out(`{yellow-fg}📍 ${waMarkup(row.text)}{/yellow-fg}`, row)
      else if (type === 'contact') out(`{yellow-fg}👤 ${esc(row.text)}{/yellow-fg}`, row)
      else if (type === 'poll') for (const l of row.text.split('\n')) out(`{yellow-fg}${esc(l)}{/yellow-fg}`, row)
      else if (type !== 'text') out(dim(esc(row.text || `[${type}]`)), row)

      if (row.text && (type === 'text' || type === 'image' || type === 'video' || type === 'gif' || type === 'document')) {
        for (const l of waMarkup(row.text).split('\n')) out(l, row)
      }
      // Reacções por baixo: cada emoji com quem reagiu, ou só a contagem quando foram vários.
      const rs = reactions.get(row.id)
      if (rs?.length) {
        const byEmoji = new Map<string, string[]>()
        // Só o primeiro nome, para a linha ficar curta.
        for (const r of rs) byEmoji.set(r.emoji, [...(byEmoji.get(r.emoji) ?? []), r.sender_jid === this.wa.me ? 'eu' : contactName(r.sender_jid).split(' ')[0]!])
        const parts = [...byEmoji].map(([emoji, who]) => `${emoji} ${who.length > 1 ? who.length : who[0]}`)
        out(dim(esc(parts.join('  '))), row)
      }
      push('', null)
    }

    this.lineMap = map
    this.images = images
    this.msgBox.setContent(lines.join('\n'))
    if (this.atBottom) this.msgBox.setScrollPerc(100)
  }

  /**
   * Reserva o espaço da imagem e desenha-a se já estiver descodificada. A descarga e a descodificação só acontecem
   * quando a imagem fica visível no painel (loadVisibleImages), nunca para as 300 mensagens de uma vez.
   */
  private pushImage(row: MessageRow, push: (l: string, r: MessageRow | null) => void, images: ImageSlot[], lines: string[], width: number, mine = false) {
    if (this.mode === 'none') { push(dim(`[${row.type}]`), row); return }
    if (row.media_err && !this.imagePathFor(row)) { push(dim(`[${row.type} indisponível]`), row); return }
    const path = this.imagePathFor(row)
    const d = path ? cached(path) : undefined
    if (d instanceof Error) { push(dim(`[${row.type} ilegível: ${esc(d.message)}]`), row); return }
    // Tamanho: dos pixels se já os temos, senão das dimensões que a mensagem traz, senão um rectângulo por omissão.
    const w = d?.w ?? row.media_w ?? 4, h = d?.h ?? row.media_h ?? 3
    // Em blocos a imagem ocupa a largura toda do painel, para se ver melhor com tão pouca resolução; em Kitty, com
    // pixels a sério, chega o tamanho natural até 60 colunas. A altura nunca passa o painel.
    const maxRows = row.type === 'sticker' ? 8 : Math.max(4, this.innerHeight() - 2)
    const { cols, rows } = this.kitty
      ? cellSize(w, h, Math.min(width - 1, 60), Math.min(maxRows, 18))
      : cellSize(w, h, width - 1, maxRows, true)
    const pad = mine ? Math.max(0, width - 1 - cols) : 0
    if (!d) {
      images.push({ row, origLine: lines.length, cols, rows, pad })
      push(`${' '.repeat(pad)}${dim(`[${row.type}${path ? ' a carregar…' : row.media_path ? '' : ' a descarregar…'}]`)}`, row)
      for (let i = 1; i < rows; i++) push('', row)
      return
    }
    if (this.kitty) {
      images.push({ row, origLine: lines.length, cols, rows, d, pad, path: path! })
      for (let i = 0; i < rows; i++) push('', row)
    } else {
      for (const l of halfBlocks(d, cols, rows)) push(' '.repeat(pad) + l, row)
    }
  }

  /** Linhas desenhadas [início, fim) de uma imagem, e a janela visível do painel. */
  private imageSpan(img: ImageSlot): { top: number; bottom: number } | null {
    const top = this.msgBox._clines?.ftor?.[img.origLine]?.[0]
    return top == null ? null : { top, bottom: top + img.rows }
  }

  /** Depois de cada frame: descarrega e descodifica só as imagens que estão à vista. */
  private loadVisibleImages() {
    if (!this.current || this.pickerOpen) return
    const base = this.msgBox.childBase, innerH = this.innerHeight()
    for (const img of this.images) {
      if (img.d) continue
      const span = this.imageSpan(img)
      if (!span || span.bottom <= base || span.top >= base + innerH) continue
      const row = store.getMessage(img.row.chat_jid, img.row.id) ?? img.row
      const path = this.imagePathFor(row)
      if (path && !cached(path)) {
        uiLog.info({ id: row.id, path }, 'descodificar imagem visível')
        decode(path).then(() => { if (this.current === row.chat_jid) { this.dirtyMessages = true; this.scheduleRender() } })
      }
      // Miniatura à mão enquanto o ficheiro completo não chega; vídeos e gifs ficam só pela miniatura.
      if (!row.media_path && !row.media_err && row.type !== 'video' && row.type !== 'gif') this.wa.ensureMedia(row)
    }
  }

  /** Depois de cada frame do blessed: volta a colocar as imagens Kitty visíveis no painel de mensagens. */
  private placeImages() {
    if (!this.kitty) return
    this.kitty.clear()
    if (!this.images.length || !this.current || this.pickerOpen) return
    const clines = this.msgBox._clines
    if (!clines?.ftor) return
    const base = this.msgBox.childBase
    const innerH = this.innerHeight()
    const col = num(this.msgBox.aleft) + num(this.msgBox.ileft) + 1
    for (const img of this.images) {
      if (!img.d || !img.path) continue
      const top = clines.ftor[img.origLine]?.[0]
      if (top == null) continue
      const bottom = top + img.rows
      const visTop = Math.max(top, base), visBottom = Math.min(bottom, base + innerH)
      if (visTop >= visBottom) continue
      const row = num(this.msgBox.atop) + num(this.msgBox.itop) + (visTop - base) + 1
      this.kitty.place(img.path, img.d, col + img.pad, row, img.cols, visBottom - visTop, (visTop - top) / img.rows, (visBottom - top) / img.rows)
    }
  }

  private openMedia(row: MessageRow) {
    if (!row.media_path) {
      if (row.media_err) return this.flash('anexo indisponível (expirou no WhatsApp)')
      this.wa.ensureMedia(row)
      return this.flash('a descarregar…')
    }
    const child = spawn('xdg-open', [row.media_path], { detached: true, stdio: 'ignore' })
    child.on('error', e => this.flash(`não consegui abrir (xdg-open): ${e.message}`))
    child.unref()
  }
}
