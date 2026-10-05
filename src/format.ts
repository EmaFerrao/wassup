import blessed from 'blessed'
import { tameEmoji } from './unicode.js'

export const strWidth = (s: string): number => (blessed as unknown as { unicode: { strWidth: (s: string) => number } }).unicode.strWidth(s)

/** Texto do utilizador pronto para o ecrã: chavetas escapadas (o blessed lê-as como etiquetas) e emojis domados. */
export function esc(s: string): string {
  return tameEmoji(s).replace(/[{}]/g, m => (m === '{' ? '{open}' : '{close}'))
}

const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g

/**
 * Converte a marcação do WhatsApp em etiquetas do blessed: *negrito*, _itálico_ (sublinhado, o blessed não sabe itálico),
 * ~riscado~ (cinzento), `mono` e ```blocos``` (amarelo), linhas "> citação" (cinzento) e endereços (azul sublinhado).
 */
export function waMarkup(text: string): string {
  const blocks: string[] = []
  let s = esc(text).replace(/```([\s\S]*?)```/g, (_m, code: string) => {
    blocks.push(code)
    return `\u0000${blocks.length - 1}\u0000`
  })
  s = s.replace(/`([^`\n]+)`/g, '{yellow-fg}$1{/yellow-fg}')
  s = s.replace(URL_RE, '{underline}{blue-fg}$1{/blue-fg}{/underline}')
  const inline = (ch: string, open: string, close: string) => {
    const c = ch.replace(/[*~_]/g, '\\$&')
    s = s.replace(new RegExp(`(^|[\\s(\\[{>])${c}(\\S(?:[^${c}\\n]*?\\S)?)${c}(?=$|[\\s.,!?;:)\\]}])`, 'gm'), `$1${open}$2${close}`)
  }
  inline('*', '{bold}', '{/bold}')
  inline('_', '{underline}', '{/underline}')
  inline('~', `{${DIM}-fg}~`, `~{/${DIM}-fg}`)
  s = s.replace(/^(&gt;|>) ?(.*)$/gm, (_m, _q, line: string) => dim(`│ ${line}`))
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `{yellow-fg}${blocks[Number(i)]}{/yellow-fg}`)
  return s
}

// Índices da paleta de 256 cores: nas etiquetas o blessed só aceita os oito nomes básicos, e aproxima hexadecimais às 16 básicas.
// Tons claros para fundos escuros e tons escuros para fundos claros, pela mesma ordem de matizes.
const PALETTE_DARK_BG = [81, 213, 221, 120, 210, 111, 179, 151, 177, 216, 73]
const PALETTE_LIGHT_BG = [31, 127, 130, 28, 160, 25, 94, 65, 91, 166, 30]
let palette = PALETTE_DARK_BG
// Cinzento do texto secundário (horas, legendas, citações): da rampa de 256, porque o "gray" do tema (cor 8) costuma
// ser quase invisível sobre fundo escuro.
let DIM = 247

/** Escolhe a paleta dos nomes e o cinzento secundário conforme o fundo do terminal é escuro ou claro. */
export function setTheme(darkBg: boolean): void {
  palette = darkBg ? PALETTE_DARK_BG : PALETTE_LIGHT_BG
  DIM = darkBg ? 247 : 242
}

/** Texto secundário, no cinzento do tema. */
export function dim(s: string): string {
  return `{${DIM}-fg}${s}{/${DIM}-fg}`
}

export function colorFor(key: string): number {
  let h = 0
  for (const ch of key) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return palette[h % palette.length]!
}

export function fmtTime(ts: number): string {
  const d = new Date(ts * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

export function fmtDay(ts: number): string {
  const d = new Date(ts * 1000)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  const today = d.toDateString() === now.toDateString()
  if (today) return 'hoje'
  const y = new Date(now); y.setDate(y.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return 'ontem'
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? '' : ` ${d.getFullYear()}`}`
}

export function dayKey(ts: number): string {
  return new Date(ts * 1000).toDateString()
}

/** Corta à largura pedida em células, com reticências. */
export function truncate(s: string, width: number): string {
  if (strWidth(s) <= width) return s
  let out = ''
  for (const ch of s) {
    if (strWidth(out + ch) > width - 1) break
    out += ch
  }
  return out + '…'
}

export function padEnd(s: string, width: number): string {
  const w = strWidth(s)
  return w >= width ? s : s + ' '.repeat(width - w)
}

const TAG_RE = /(\{[^}]*\})/

/** Largura visível de uma linha com etiquetas do blessed: as etiquetas não ocupam células, `{open}`/`{close}` ocupam uma. */
export function visibleWidth(s: string): number {
  return strWidth(s.replace(/\{[^}]*\}/g, m => (m === '{open}' || m === '{close}' ? 'x' : '')))
}

/**
 * Parte uma linha com etiquetas em linhas de largura visível ≤ `width`, por palavras (ou por caracteres quando a
 * palavra não cabe). As etiquetas ficam onde estavam; o blessed mantém o estado delas entre linhas.
 */
export function wrapTagged(s: string, width: number): string[] {
  const lines: string[] = []
  let cur = '', curW = 0
  const newline = () => { lines.push(cur.replace(/\s+$/, '')); cur = ''; curW = 0 }
  const emit = (piece: string, w: number) => {
    if (curW + w <= width) { cur += piece; curW += w; return }
    if (w <= width) { newline(); cur = piece; curW = w; return }
    for (const ch of piece) {
      const cw = strWidth(ch)
      if (curW + cw > width) newline()
      cur += ch; curW += cw
    }
  }
  for (const tok of s.split(TAG_RE)) {
    if (!tok) continue
    if (TAG_RE.test(tok)) {
      if (tok === '{open}' || tok === '{close}') emit(tok, 1)
      else cur += tok
      continue
    }
    for (const piece of tok.split(/(\s+)/)) {
      if (!piece) continue
      if (/^\s+$/.test(piece)) { if (curW + piece.length <= width) { cur += piece; curW += piece.length } else newline(); continue }
      emit(piece, strWidth(piece))
    }
  }
  if (cur || !lines.length) lines.push(cur.replace(/\s+$/, ''))
  return lines
}

/** Encosta uma linha com etiquetas ao bordo direito de `width` células. */
/** Grafemas de um texto (o que o utilizador vê como um carácter: emoji com tom, bandeira, letra com acento). */
export function graphemes(s: string): string[] {
  return Array.from(new Intl.Segmenter().segment(s), g => g.segment)
}

/**
 * Parte texto cru (já em grafemas, sem etiquetas) em linhas de largura ≤ `width`, por palavras (ou por caracteres
 * quando a palavra não cabe). Ao contrário do wrapTagged, nada se apaga: cada grafema cai numa linha e coluna, para o
 * cursor e o rato se poderem mapear. Os espaços ficam no fim da linha onde estavam, e passam à seguinte se não cabem.
 */
export function wrapChars(chars: string[], width: number): string[][] {
  const lines: string[][] = [[]]
  let curW = 0
  const cw = (c: string) => visibleWidth(esc(c))
  const push = (ch: string, w: number) => {
    if (curW > 0 && curW + w > width) { lines.push([]); curW = 0 }
    lines[lines.length - 1]!.push(ch); curW += w
  }
  for (let i = 0; i < chars.length;) {
    if (/^\s$/.test(chars[i]!)) { push(chars[i]!, 1); i++; continue }
    let j = i, w = 0
    while (j < chars.length && !/^\s$/.test(chars[j]!)) w += cw(chars[j++]!)
    if (curW > 0 && curW + w > width && w <= width) { lines.push([]); curW = 0 }
    for (; i < j; i++) push(chars[i]!, cw(chars[i]!))
  }
  return lines
}

export function alignRight(s: string, width: number): string {
  return ' '.repeat(Math.max(0, width - visibleWidth(s))) + s
}

/** Para comparar sem acentos nem maiúsculas: "Ferrão" e "ferrao" casam. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}
