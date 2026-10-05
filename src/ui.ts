import blessed from 'blessed'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import QRCode from 'qrcode'
import { store, type ChatRow, type MessageRow } from './db.js'
import { chatName, contactName, thumbPath, jidUser, type ConnState } from './wa.js'
import type { Backend } from './backend.js'
import { waMarkup, esc, colorFor, fmtTime, fmtDay, dayKey, truncate, strWidth, wrapTagged, alignRight, visibleWidth, fold } from './format.js'
import { decode, cached, cellSize, halfBlocks, detectImageMode, KittyImages, type Decoded, type ImageMode } from './image.js'
import { logger, uiLog } from './log.js'
import { patchBlessedUnicode } from './unicode.js'
import type { TermCaps } from './term.js'
import { emojify } from './emoji.js'

type Focus = 'picker' | 'messages' | 'input'

/** Uma imagem no painel: pronta (com pixels) ou só reservada, à espera de ser descarregada e descodificada quando ficar visível. */
interface ImageSlot { row: MessageRow; origLine: number; cols: number; rows: number; pad: number; path?: string; d?: Decoded }

/** Um troço da barra de tabs: a que tab corresponde e onde está o seu × (ou se é o +). */
interface TabSegment { x0: number; x1: number; index: number; closeX0: number; closeX1: number; plus?: boolean }

const num = (x: unknown): number => x as number

// Campos internos do blessed que a interface usa: as linhas já partidas à largura do painel e os mapas entre
// linha original e linha desenhada (ftor: original→desenhadas, rtof: desenhada→original).
interface ClinesBox extends blessed.Widgets.BoxElement {
  _clines: string[] & { ftor: number[][]; rtof: number[] }
  childBase: number
}

const HELP = 'Tab/Shift-Tab muda de tab · Ctrl-T outras conversas · Ctrl-W fecha tab · Esc fecha · PgUp/PgDn histórico · :up ficheiro · :down anexos · :fixe: emoji'

// Cores por índice da paleta de 256: o blessed aproxima qualquer cor hexadecimal às 16 básicas.
// Esquema de cores, por índice da paleta de 256. Barra de tabs e "outras conversas" em preto; o tab activo tem o fundo
// da escrita, ligeiramente mais claro, e fica ligado a ela; os inactivos ficam no preto com texto claro e separadores.
const BG = { bar: 16, messages: 233, messagesFocus: 234, input: 234, inputFocus: 235, picker: 16, pickerFocus: 16 }
// Os avisos passageiros são discretos; só a espera do QR e as quebras de ligação se destacam. Ligado não se mostra.
const FG = { tab: 250, tabDim: 244, separator: 240, badge: 203, note: 245, warn: 221, error: 203 }

export class Ui {
  private screen: blessed.Widgets.Screen
  private tabsBar: blessed.Widgets.BoxElement
  private msgBox: ClinesBox
  private input: blessed.Widgets.BoxElement
  private picker: blessed.Widgets.ListElement

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
  private lineMap: (MessageRow | null)[] = []
  private images: ImageSlot[] = []
  private mode: ImageMode
  private kitty: KittyImages | undefined
  private connText = 'a ligar…'
  private transient = ''
  private transientTimer: NodeJS.Timeout | undefined
  private atBottom = true
  private renderTimer: NodeJS.Timeout | undefined
  private dirtyTabs = true
  private dirtyMessages = true
  private showingQr = false

  constructor(private wa: Backend, caps: TermCaps) {
    this.mode = detectImageMode(caps.kittyGraphics)
    patchBlessedUnicode()
    this.screen = blessed.screen({ smartCSR: true, fullUnicode: caps.utf8, title: 'wa', warnings: false })
    // Com localização UTF-8 as molduras saem em caracteres de caixa Unicode (─│┌). Sem isto o blessed muda para o
    // conjunto DEC de linhas, que apps de SSH no telemóvel não conhecem e mostram como q, x, l, k.
    if (caps.utf8) (this.screen.program as unknown as { tput: { brokenACS: boolean } }).tput.brokenACS = true
    const program = this.screen.program as unknown as { _write: (s: string) => void }
    if (this.mode === 'kitty') this.kitty = new KittyImages(s => program._write(s))
    logger.info({ caps, images: this.mode, term: process.env.TERM }, 'terminal')

    // Disposição: mensagens a toda a largura, escrita em duas linhas, e no fundo a barra de tabs com o estado à direita.
    this.tabsBar = blessed.box({
      parent: this.screen, top: '100%-1', left: 0, width: '100%', height: 1, tags: true, mouse: true,
      style: { bg: BG.bar } as unknown as blessed.Widgets.Types.TStyle,
    })
    this.msgBox = blessed.box({
      parent: this.screen, top: 0, left: 0, right: 0, height: '100%-3', padding: { left: 1, right: 1 },
      tags: true, scrollable: true, alwaysScroll: true, keys: true, vi: true, mouse: true,
      style: { bg: BG.messages, focus: { bg: BG.messagesFocus } } as unknown as blessed.Widgets.Types.TStyle,
    }) as ClinesBox
    this.input = blessed.box({
      parent: this.screen, top: '100%-3', left: 0, right: 0, height: 2, padding: { left: 1, right: 1 },
      tags: true, mouse: true,
      style: { bg: BG.input, focus: { bg: BG.inputFocus } } as unknown as blessed.Widgets.Types.TStyle,
    })
    this.picker = blessed.list({
      parent: this.screen, top: 0, left: 0, right: 0, height: '100%-3', padding: { left: 1, right: 1 }, hidden: true,
      tags: true, keys: true, mouse: true,
      style: { bg: BG.picker, focus: { bg: BG.pickerFocus }, item: { bg: BG.picker }, selected: { bg: 24, fg: 'white', bold: true } } as unknown as blessed.Widgets.ListElementStyle,
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
    this.loadTabs()
    this.setFocus('input')
    this.drawInput()
    this.drawStatus()
    this.renderNow()
  }

  private get current(): string | null {
    return this.tabs[this.active] ?? null
  }

  // ---------- eventos ----------

  private bindEvents() {
    this.bindDiagnostics()
    this.screen.on('keypress', (ch: string, key: blessed.Widgets.Events.IKeyEventArg) => this.onKey(ch, key))
    this.screen.on('resize', () => { this.dirtyMessages = true; this.dirtyTabs = true; this.scheduleRender() })
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
      if (seg.plus) return this.openPicker()
      if (x >= seg.closeX0 && x < seg.closeX1) return this.closeTab(seg.index)
      this.activateTab(seg.index)
    })
    // Clicar nas mensagens activa a escrita (e abre o anexo se o clique cair num).
    this.msgBox.on('click', (data: { x: number; y: number }) => {
      this.setFocus('input')
      const line = this.msgBox.childBase + (data.y - num(this.msgBox.atop) - num(this.msgBox.itop))
      const orig = this.msgBox._clines?.rtof?.[line]
      const row = orig != null ? this.lineMap[orig] : null
      if (row?.media_mime) this.openMedia(row)
      this.screen.render()
    })
    this.msgBox.on('scroll', () => this.updateAtBottom())
    this.input.on('click', () => { this.setFocus('input'); this.screen.render() })

    this.wa.on('connection', (state, detail) => this.onConnection(state, detail))
    this.wa.on('chats', () => { this.dirtyTabs = true; if (this.pickerOpen) this.refreshPicker(); this.scheduleRender() })
    this.wa.on('messages', jid => { if (jid === '*' || jid === this.current) this.dirtyMessages = true; this.dirtyTabs = true; this.scheduleRender() })
    this.wa.on('notify', (jid, row) => {
      // Mensagem nova numa conversa sem tab: abre-se um tab no fim, sem o activar nem reordenar os outros.
      if (!this.tabs.includes(jid)) this.openTab(jid, false)
      if (jid === this.current) {
        this.wa.markRead(jid).catch(e => logger.warn({ e }, 'markRead'))
      } else {
        this.screen.program.bell()
        this.flash(`${chatName(jid)}: ${truncate(row.text || `[${row.type}]`, 60)}`)
      }
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
    this.screen.on('mouse', (d: { action: string; button?: string; x: number; y: number; shift?: boolean; ctrl?: boolean }) =>
      uiLog.info({ action: d.action, button: d.button, x: d.x, y: d.y, shift: d.shift, ctrl: d.ctrl }, 'rato'))
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
        this.lineMap = []; this.images = []
        this.screen.render()
      })
      this.connText = `{${FG.warn}-fg}● à espera do QR{/${FG.warn}-fg}`
    } else if (state === 'open') {
      this.connText = ''
      this.showingQr = false
      this.dirtyMessages = true
      this.scheduleRender()
    } else if (state === 'closed') {
      this.connText = `{${FG.error}-fg}● ${esc(detail ?? 'desligado')}{/${FG.error}-fg}`
    } else {
      this.connText = `{${FG.warn}-fg}● a ligar…{/${FG.warn}-fg}`
    }
    this.drawStatus()
    this.screen.render()
  }

  private onKey(ch: string, key: blessed.Widgets.Events.IKeyEventArg) {
    const k = key.full
    if (k === 'C-c') return this.quit()
    // ESC fecha, por ordem: o filtro do escolhedor, o escolhedor, o tab activo, o programa.
    if (k === 'escape') {
      if (this.pickerOpen) {
        if (this.filter) { this.filter = ''; this.refreshPicker(); return this.screen.render() }
        // Sem tabs não há para onde voltar: o escolhedor é o único painel, e fechá-lo é sair.
        return this.tabs.length ? this.closePicker() : this.quit()
      }
      if (this.current) return this.closeTab(this.active)
      return this.quit()
    }
    if (k === 'C-t') return this.openPicker()
    if (k === 'C-w') { if (this.current) this.closeTab(this.active); return }
    if (k === 'C-n' || k === 'C-p') {
      if (!this.tabs.length) return
      return this.activateTab((this.active + (k === 'C-n' ? 1 : -1) + this.tabs.length) % this.tabs.length)
    }
    if (k === 'pageup') { this.msgBox.scroll(-(this.innerHeight() - 1)); return this.screen.render() }
    if (k === 'pagedown') { this.msgBox.scroll(this.innerHeight() - 1); return this.screen.render() }
    // Tab e Shift-Tab percorrem a barra: cada tab por ordem e, no fim, o + (o escolhedor de conversa nova).
    if (k === 'tab' || k === 'S-tab') {
      const n = this.tabs.length
      const pos = this.pickerOpen ? n : this.active
      const next = (pos + (k === 'tab' ? 1 : -1) + n + 1) % (n + 1)
      if (next === n) this.openPicker()
      else this.activateTab(next)
      return
    }

    if (this.focus === 'picker') {
      // Escrever com o escolhedor aberto filtra as conversas; setas e Enter são da lista.
      if (k === 'backspace') { this.filter = Array.from(this.filter).slice(0, -1).join(''); this.refreshPicker(); return this.screen.render() }
      if (ch && !key.ctrl && !key.meta && ch >= ' ' && ch !== '\x7f') { this.filter += ch; this.refreshPicker(); return this.screen.render() }
      return
    }
    if (this.focus === 'input') {
      if (k === 'enter' || k === 'return') { const v = this.inputValue; this.inputValue = ''; this.drawInput(); this.screen.render(); return void this.submit(v) }
      if (k === 'backspace') this.inputValue = Array.from(this.inputValue).slice(0, -1).join('')
      else if (k === 'C-u') this.inputValue = ''
      else if (k === 'C-w') this.inputValue = this.inputValue.replace(/\S*\s*$/, '')
      else if (ch && !key.ctrl && !key.meta && ch >= ' ' && ch !== '\x7f') this.inputValue += ch
      else return
      this.drawInput()
      return this.screen.render()
    }
    if (this.focus === 'messages' && k === 'i') { this.setFocus('input'); return this.screen.render() }
  }

  private async submit(v: string) {
    const text = emojify(v.trim())
    if (!text) return
    if (text === ':q' || text === ':quit') return this.quit()
    if (text === ':help' || text === ':h') return this.flash(HELP, 15000)
    if (text.startsWith('/')) return this.openPicker(text.slice(1).trim())
    if (!this.current) return this.flash('abre primeiro uma conversa (Ctrl-T ou "outras conversas")')
    if (this.wa.state !== 'open') return this.flash('sem ligação ao WhatsApp; espera pelo ● verde')
    const jid = this.current
    // Ao enviar, o painel vai para o fundo para mostrar a mensagem nova, mesmo que estivesse a ver o histórico.
    this.atBottom = true
    try {
      if (text.startsWith(':up ') || text.startsWith(':send ')) {
        const rest = text.replace(/^:\w+\s+/, '')
        const m = /^(?:"([^"]+)"|(\S+))\s*(.*)$/.exec(rest)
        const file = (m?.[1] ?? m?.[2] ?? '').replace(/^~(?=$|\/)/, os.homedir())
        if (!file || !fs.existsSync(file)) return this.flash(`ficheiro não encontrado: ${file}`)
        this.flash(`a enviar ${file}…`)
        await this.wa.sendFile(jid, file, m?.[3] || undefined)
        return this.flash('enviado')
      }
      if (text === ':down') {
        const r = await this.wa.downloadAll(jid)
        return this.flash(`${r.copied} anexos copiados para ~/Downloads/wa${r.pending ? `, ${r.pending} ainda a descarregar (repete :down daqui a pouco)` : ''}`)
      }
      if (text.startsWith(':')) return this.flash(`comando desconhecido: ${text.split(' ')[0]}. ${HELP}`, 10000)
      await this.wa.send(jid, text)
    } catch (e) {
      logger.error({ e }, 'submit')
      this.flash(`erro: ${(e as Error).message}`, 10000)
    }
  }

  // ---------- tabs ----------

  /** Cada terminal tem os seus tabs: a chave é o dispositivo do terminal (/dev/pts/N), que se mantém enquanto ele existir. */
  private tabsKey(): string {
    try { return `tabs:${fs.readlinkSync('/proc/self/fd/0')}` } catch { return 'tabs' }
  }

  private loadTabs() {
    const saved = store.getState<{ tabs: string[]; active: number }>(this.tabsKey())
    if (!saved) return
    this.tabs = saved.tabs.filter(jid => store.getChat(jid))
    this.active = this.tabs.length ? Math.min(Math.max(saved.active, 0), this.tabs.length - 1) : -1
  }

  private saveTabs() {
    store.setState(this.tabsKey(), { tabs: this.tabs, active: this.active })
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

  private activateTab(i: number) {
    const jid = this.tabs[i]
    if (!jid) return
    if (i !== this.active) { this.active = i; this.atBottom = true; this.dirtyMessages = true }
    this.dirtyTabs = true
    this.saveTabs()
    if (this.pickerOpen) this.closePicker(false)
    this.setFocus('input')
    this.renderNow()
    this.wa.markRead(jid).catch(e => logger.warn({ e }, 'markRead'))
  }

  /** Fecha o tab; se era o activo passa para o da direita, ou o da esquerda, ou para as "outras conversas". */
  private closeTab(i: number) {
    if (!this.tabs[i]) return
    uiLog.info({ jid: this.tabs[i], index: i }, 'fechar tab')
    this.tabs.splice(i, 1)
    if (this.active > i) this.active--
    else if (this.active === i) { this.active = Math.min(i, this.tabs.length - 1); this.atBottom = true }
    this.dirtyTabs = true
    this.dirtyMessages = true
    this.lineMap = []; this.images = []
    this.saveTabs()
    this.renderNow()
    // Sem tabs, o renderNow abre as "outras conversas"; sair fica para o Esc aí.
    const jid = this.current
    if (jid) this.wa.markRead(jid).catch(e => logger.warn({ e }, 'markRead'))
  }

  private drawTabs() {
    const width = num(this.tabsBar.width)
    // O último tab é "outras conversas", com a soma das não lidas das conversas sem tab aberto.
    const others = store.listChats().filter(c => !c.archived && !this.tabs.includes(c.jid)).reduce((sum, c) => sum + c.unread, 0)
    const othersBadge = others > 0 ? `(${others})` : ''
    const plus = ` outras conversas${othersBadge ? ' ' + othersBadge : ''} `
    const maxName = Math.max(0, width - (this.pickerOpen ? strWidth(plus) : 0))
    const tabs = this.tabs.map((jid, i) => {
      const unread = store.getChat(jid)?.unread ?? 0
      return { jid, i, name: chatName(jid), badge: unread > 0 ? `(${unread})` : '' }
    })
    // Encurtar os nomes para caberem todos, até um mínimo de 6 caracteres; para lá disso a barra corta à direita.
    const overhead = (t: { badge: string }) => 1 + (t.badge ? strWidth(t.badge) + 1 : 0) + 2 + 1
    let nameW = Math.max(...tabs.map(t => strWidth(t.name)), 0)
    const fits = (w: number) => tabs.reduce((sum, t) => sum + Math.min(strWidth(t.name), w) + overhead(t), 0) <= maxName
    while (nameW > 6 && !fits(nameW)) nameW--
    // A escrita muda de tom quando está activa; o tab activo acompanha-a para o fundo ser sempre o mesmo.
    const activeBg = this.focus === 'input' ? BG.inputFocus : BG.input
    let out = '', x = 0
    this.segments = []
    for (const t of tabs) {
      const name = truncate(t.name, nameW)
      const text = ` ${name}${t.badge ? ' ' + t.badge : ''} ×│`
      const w = strWidth(text)
      const closeX0 = x + w - 2
      this.segments.push({ x0: x, x1: x + w, index: t.i, closeX0, closeX1: closeX0 + 1 })
      const badge = t.badge ? ` {${FG.badge}-fg}{bold}${t.badge}{/bold}{/${FG.badge}-fg}` : ''
      out += t.i === this.active
        ? `{${activeBg}-bg}{white-fg}{bold} ${esc(name)}{/bold}${badge} {${FG.tabDim}-fg}×{/${FG.tabDim}-fg} {/white-fg}{/${activeBg}-bg}`
        : `{${FG.tab}-fg} ${esc(name)}${badge} {${FG.tabDim}-fg}×{/${FG.tabDim}-fg}{/${FG.tab}-fg}{${FG.separator}-fg}│{/${FG.separator}-fg}`
      x += w
    }
    // O tab "outras conversas" só existe enquanto o escolhedor está aberto; volta-se a ele com Esc, Tab ou Ctrl-T.
    if (this.pickerOpen) {
      this.segments.push({ x0: x, x1: x + strWidth(plus), index: -1, closeX0: 0, closeX1: 0, plus: true })
      const plusText = ` outras conversas${othersBadge ? ` {${FG.badge}-fg}{bold}${othersBadge}{/bold}{/${FG.badge}-fg}` : ''} `
      out += `{${activeBg}-bg}{white-fg}{bold}${plusText}{/bold}{/white-fg}{/${activeBg}-bg}`
      x += strWidth(plus)
    }
    // Estado encostado à direita: a mensagem passageira (amarela) ou a ligação; cortado se não couber.
    // Ligado não se anuncia: só avisos passageiros e os estados que pedem atenção (QR, ligação caída).
    const avail = width - x - 2
    const text = this.transient ? `{${FG.note}-fg}${esc(truncate(this.transient, avail))}{/${FG.note}-fg}` : this.connText
    if (avail >= 6 && text) out += ' '.repeat(Math.max(1, width - x - visibleWidth(text) - 1)) + text
    this.tabsBar.setContent(out)
  }

  // ---------- escolhedor ----------

  private openPicker(filter = '') {
    this.filter = filter
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

  private pickChat(index: number) {
    const jid = this.filtered[index]?.jid
    uiLog.info({ index, jid }, 'escolher conversa')
    if (!jid) return
    this.openTab(jid)
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
      return `${left}${' '.repeat(Math.max(1, nameW - visibleWidth(left)))}{245-fg}${esc(preview)}{/245-fg}`
    })
    this.picker.setItems(items as unknown as string[])
    // Lista encostada ao fundo, junto ao prompt, quando é mais curta que o painel.
    const panel = num(this.screen.height) - 3
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
    if (this.dirtyTabs) { this.dirtyTabs = false; this.drawTabs() }
    if (this.dirtyMessages && !this.showingQr) { this.dirtyMessages = false; if (this.current) this.renderMessages() }
    // Sem tabs não há painel inicial: fica o escolhedor (excepto enquanto se mostra o QR, sem conversas ainda).
    if (!this.current && !this.pickerOpen && !this.showingQr && store.listChats().length) return this.openPicker()
    this.screen.render()
  }

  quit(reason?: string) {
    this.kitty?.dispose()
    this.screen.destroy()
    if (reason) process.stderr.write(`${reason}\n`)
    this.wa.stop().catch(() => {})
    store.close()
    process.exit(0)
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

  private drawInput() {
    // Duas linhas, prompt ">" na primeira, texto partido por palavras (nunca a meio de uma) e continuação indentada.
    // Com mais de duas linhas mostram-se as duas últimas, onde está o cursor. Com as "outras conversas" abertas, a
    // mesma linha serve para escrever o filtro.
    const w = num(this.input.width) - num(this.input.iwidth) - 1
    const value = this.pickerOpen ? this.filter : this.inputValue
    const lines = wrapTagged(esc(value), Math.max(4, w - 2))
    const cursor = this.focus === 'input' || this.focus === 'picker' ? '{inverse} {/inverse}' : ''
    const last = lines.length - 1
    if (visibleWidth(lines[last]!) >= w - 2) lines.push(cursor)
    else lines[last] += cursor
    const visible = lines.slice(-2)
    const first = lines.length <= 2
    this.input.setContent(visible.map((l, i) => (i === 0 && first ? '> ' : '  ') + l).join('\n'))
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
    const push = (line: string, row: MessageRow | null) => { lines.push(line); map.push(row) }
    let lastDay = ''

    for (const row of store.listMessages(jid)) {
      const day = dayKey(row.ts)
      if (day !== lastDay) {
        lastDay = day
        const label = `── ${fmtDay(row.ts)} ──`
        push(`{gray-fg}${' '.repeat(Math.max(0, Math.floor((width - strWidth(label)) / 2)))}${label}{/gray-fg}`, null)
      }
      // As minhas mensagens ficam encostadas à direita: parto eu as linhas (o blessed só parte pela esquerda) e
      // encosto cada uma ao bordo; as dos outros ficam à esquerda e o blessed parte-as.
      const mine = row.from_me === 1
      // Uma coluna de margem à direita: o blessed parte a linha se uma etiqueta de fecho cair na última coluna.
      const out = (line: string, r: MessageRow | null) => {
        if (!mine) { push(line, r); return }
        for (const l of wrapTagged(line, width - 1)) push(alignRight(l, width - 1), r)
      }
      const name = mine ? 'eu' : isGroup ? contactName(row.sender_jid) : chatName(jid)
      const color = mine ? 'green' : colorFor(row.sender_jid)
      const ticks = !mine ? '' : (row.status ?? 0) >= 4 ? '{cyan-fg}✓✓{/cyan-fg}' : (row.status ?? 0) >= 3 ? '✓✓' : (row.status ?? 0) >= 2 ? '✓' : '{gray-fg}○{/gray-fg}'
      // Nas minhas a hora vem antes do "eu"; nomes sem negrito, só a cor.
      out(mine
        ? `{gray-fg}${fmtTime(row.ts)}{/gray-fg} {${color}-fg}${esc(name)}{/${color}-fg} ${ticks}`
        : `{${color}-fg}${esc(name)}{/${color}-fg} {gray-fg}${fmtTime(row.ts)}{/gray-fg}`, row)
      if (row.quoted) {
        const [who, text] = row.quoted.split('\t')
        const author = who === this.wa.me ? '' : `${esc(contactName(who ?? ''))}: `
        out(`{gray-fg}│ ${author}${esc(truncate(text ?? '', width - 6))}{/gray-fg}`, row)
      }

      const type = row.type
      const mediaHint = row.media_path ? '{gray-fg}(clique para abrir){/gray-fg}' : row.media_err ? '{gray-fg}(indisponível){/gray-fg}' : '{gray-fg}(clique para descarregar){/gray-fg}'
      if (type === 'deleted') out('{gray-fg}⊘ mensagem apagada{/gray-fg}', row)
      else if (type === 'image' || type === 'sticker' || type === 'gif' || type === 'video') {
        this.pushImage(row, push, images, lines, width, mine)
        if (type === 'video' || type === 'gif') out(`{magenta-fg}▶ ${type === 'gif' ? 'gif' : 'vídeo'}{/magenta-fg} ${mediaHint}`, row)
      } else if (type === 'document') {
        out(`{yellow-fg}📎 ${esc(row.media_name ?? 'ficheiro')}{/yellow-fg} ${mediaHint}`, row)
      } else if (type === 'audio' || type === 'voice') {
        out(`{yellow-fg}${type === 'voice' ? '🎤' : '🎵'} ${type === 'voice' ? 'mensagem de voz' : 'áudio'} ${esc(row.text)}{/yellow-fg} ${row.media_path ? '{gray-fg}(clique para ouvir){/gray-fg}' : mediaHint}`, row)
      } else if (type === 'location') out(`{yellow-fg}📍 ${waMarkup(row.text)}{/yellow-fg}`, row)
      else if (type === 'contact') out(`{yellow-fg}👤 ${esc(row.text)}{/yellow-fg}`, row)
      else if (type === 'poll') for (const l of row.text.split('\n')) out(`{yellow-fg}${esc(l)}{/yellow-fg}`, row)
      else if (type !== 'text') out(`{gray-fg}${esc(row.text || `[${type}]`)}{/gray-fg}`, row)

      if (row.text && (type === 'text' || type === 'image' || type === 'video' || type === 'gif' || type === 'document')) {
        for (const l of waMarkup(row.text).split('\n')) out(l, row)
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
    if (this.mode === 'none') { push(`{gray-fg}[${row.type}]{/gray-fg}`, row); return }
    if (row.media_err && !this.imagePathFor(row)) { push(`{gray-fg}[${row.type} indisponível]{/gray-fg}`, row); return }
    const path = this.imagePathFor(row)
    const d = path ? cached(path) : undefined
    if (d instanceof Error) { push(`{gray-fg}[${row.type} ilegível: ${esc(d.message)}]{/gray-fg}`, row); return }
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
      push(`${' '.repeat(pad)}{gray-fg}[${row.type}${path ? ' a carregar…' : row.media_path ? '' : ' a descarregar…'}]{/gray-fg}`, row)
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
