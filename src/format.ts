import blessed from 'blessed'
import { t } from './i18n.js'
import { tameEmoji } from './unicode.js'
import { URL_RE, cleanUrl, shortUrl } from './links.js'

export const strWidth = (s: string): number => (blessed as unknown as { unicode: { strWidth: (s: string) => number } }).unicode.strWidth(s)

/** Italic, via the ANSI sequence that the patch in italic.ts teaches blessed (ESC[3m … ESC[23m, like chalk). */
export function italic(s: string): string {
  return `\x1b[3m${s}\x1b[23m`
}

/** User text ready for the screen: braces escaped (blessed reads them as tags) and emojis tamed. */
export function esc(s: string): string {
  return tameEmoji(s).replace(/[{}]/g, m => (m === '{' ? '{open}' : '{close}'))
}

/**
 * Converts WhatsApp markup into blessed tags: *bold*, _italic_ (for real, via the patch in italic.ts),
 * ~strikethrough~ (gray), `mono` and ```blocks``` (yellow), "> quote" lines (gray) and URLs (blue underline, clean
 * of tracking and shortened, see links.ts).
 */
export function waMarkup(text: string): string {
  const blocks: string[] = []
  let s = esc(text).replace(/```([\s\S]*?)```/g, (_m, code: string) => {
    blocks.push(code)
    return `\u0000${blocks.length - 1}\u0000`
  })
  s = s.replace(/`([^`\n]+)`/g, '{yellow-fg}$1{/yellow-fg}')
  s = s.replace(URL_RE, (_m, url: string) => `{underline}{${LINK}-fg}${shortUrl(cleanUrl(url))}{/${LINK}-fg}{/underline}`)
  const inline = (ch: string, open: string, close: string) => {
    const c = ch.replace(/[*~_]/g, '\\$&')
    s = s.replace(new RegExp(`(^|[\\s(\\[{>])${c}(\\S(?:[^${c}\\n]*?\\S)?)${c}(?=$|[\\s.,!?;:)\\]}])`, 'gm'), `$1${open}$2${close}`)
  }
  inline('*', '{bold}', '{/bold}')
  inline('_', '\x1b[3m', '\x1b[23m')
  inline('~', `{${DIM}-fg}~`, `~{/${DIM}-fg}`)
  s = s.replace(/^(&gt;|>) ?(.*)$/gm, (_m, _q, line: string) => dim(`│ ${line}`))
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `{yellow-fg}${blocks[Number(i)]}{/yellow-fg}`)
  return s
}

// Indices into the 256-color palette: in tags blessed only accepts the eight basic names, and approximates hex colors to the 16 basic ones.
// Light shades for dark backgrounds and dark shades for light backgrounds, in the same hue order.
const PALETTE_DARK_BG = [81, 213, 221, 120, 210, 111, 179, 151, 177, 216, 73]
const PALETTE_LIGHT_BG = [31, 127, 130, 28, 160, 25, 94, 65, 91, 166, 30]
let palette = PALETTE_DARK_BG
// Gray for secondary text (times, captions, quotes): from the 256 ramp, because the theme's "gray" (color 8) tends
// to be almost invisible on a dark background.
let DIM = 247
/** A step fainter than DIM, for the time of each message. */
let FAINT = 241
/** Links: a blue that reads on the theme's background (plain ANSI blue is too dark on a dark one). */
let LINK = 75

/** Picks the name palette and the secondary gray depending on whether the terminal background is dark or light. */
export function setTheme(darkBg: boolean): void {
  palette = darkBg ? PALETTE_DARK_BG : PALETTE_LIGHT_BG
  DIM = darkBg ? 247 : 242
  FAINT = darkBg ? 241 : 248
  LINK = darkBg ? 75 : 26
}

/** The time of a message: a gray a step closer to the background than the other secondary text. */
export function faint(s: string): string {
  return `{${FAINT}-fg}${s}{/${FAINT}-fg}`
}

/** Secondary text, in the theme's gray. */
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

const MONTHS = t('months').split(' ')

export function fmtDay(ts: number): string {
  const d = new Date(ts * 1000)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  const today = d.toDateString() === now.toDateString()
  if (today) return t('today')
  const y = new Date(now); y.setDate(y.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return t('yesterday')
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? '' : ` ${d.getFullYear()}`}`
}

/** Whole calendar days from a moment to today: 0 today, 1 yesterday… */
export function daysAgo(ts: number): number {
  const d = new Date(ts * 1000), now = new Date()
  d.setHours(0, 0, 0, 0); now.setHours(0, 0, 0, 0)
  return Math.round((now.getTime() - d.getTime()) / 86400000)
}

const WEEKDAYS = t('weekdays').split(' ')

/** When something was, short, for the chat list: the time today, "yesterday", the weekday this week, the date before. */
export function fmtWhen(ts: number): string {
  const d = new Date(ts * 1000), days = daysAgo(ts)
  if (days <= 0) return fmtTime(ts)
  if (days === 1) return t('yesterday')
  if (days < 7) return WEEKDAYS[d.getDay()]!
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === new Date().getFullYear() ? '' : ` ${d.getFullYear()}`}`
}

export function dayKey(ts: number): string {
  return new Date(ts * 1000).toDateString()
}

/** Truncates to the requested width in cells, with an ellipsis. */
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

/** Blessed tags and SGR codes: none occupy cells. */
const TAG_RE = /(\{[^}]*\}|\x1b\[[\d;]*m)/

/** Without blessed tags or SGR codes; `{open}`/`{close}` remain as one character. */
const stripTags = (s: string) => s.replace(/\x1b\[[\d;]*m/g, '').replace(/\{[^}]*\}/g, m => (m === '{open}' || m === '{close}' ? 'x' : ''))

/** Visible width of a line with blessed tags: tags occupy no cells, `{open}`/`{close}` occupy one. */
export function visibleWidth(s: string): number {
  return strWidth(stripTags(s))
}

/**
 * Width of tag-free text as blessed counts it when deciding whether to wrap the line: in UTF-16 units, with the
 * marker it puts in the second cell of each wide character. An emoji outside the basic plane (surrogate pair)
 * or a pictograph with the U+FE0F variation selector thus counts one more than the cells it occupies, and a flag
 * drawn as such (two regional indicators and the marker, in 2 cells) three more. Wrapping and aligning by this
 * measure is what keeps blessed from wrapping the line again and throwing the last word onto the next line.
 */
function wrapUnits(plain: string): number {
  let extra = 0
  for (const c of plain) if (c.codePointAt(0)! > 0xffff) extra++
  extra += plain.match(/\p{Extended_Pictographic}️/gu)?.length ?? 0
  extra += plain.match(/\p{Regional_Indicator}{2}/gu)?.length ?? 0
  return strWidth(plain) + extra
}

/** `wrapUnits` of a line with tags. */
export function wrapWidth(s: string): number {
  return wrapUnits(stripTags(s))
}

/** Cuts a tagged line to `width` visible columns, letting tags through and closing whatever is open at the end. */
export function clipTagged(s: string, width: number): string {
  let out = '', w = 0
  for (let i = 0; i < s.length;) {
    if (s[i] === '{') {
      const j = s.indexOf('}', i)
      if (j > i) { out += s.slice(i, j + 1); i = j + 1; continue }
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!)
    const cw = strWidth(ch)
    if (w + cw > width) break
    out += ch; w += cw; i += ch.length
  }
  return out + '{/}'
}

/**
 * Wraps a line with tags into lines of width ≤ `width`, by words (or by characters when the word doesn't fit),
 * measured as blessed measures it (`wrapUnits`). Each line stands on its own: what's open where it breaks (blessed's
 * tags, innermost last, and the italic's raw SGR) is closed at its end and opened again at the start of the next, so
 * what's added after a line's text (a bubble's spare cells, the time, a mark) doesn't carry on an underline or a
 * colour from a link cut in two.
 */
export function wrapTagged(s: string, width: number): string[] {
  const lines: string[] = []
  const open: string[] = []
  let italic = false
  const track = (tag: string) => {
    if (tag === '\x1b[3m') italic = true
    else if (tag === '\x1b[23m' || tag === '\x1b[0m' || tag === '\x1b[m') italic = false
    else if (tag === '{/}') open.length = 0
    else if (tag.startsWith('{/')) { const i = open.lastIndexOf(tag.slice(2, -1)); if (i >= 0) open.splice(i, 1) }
    else if (tag.startsWith('{')) open.push(tag.slice(1, -1))
  }
  let start = '', cur = '', curW = 0
  const newline = () => {
    lines.push(cur.replace(/\s+$/, '') + (italic ? '\x1b[23m' : '') + [...open].reverse().map(t => `{/${t}}`).join(''))
    start = cur = open.map(t => `{${t}}`).join('') + (italic ? '\x1b[3m' : '')
    curW = 0
  }
  const emit = (piece: string, w: number) => {
    if (curW + w <= width) { cur += piece; curW += w; return }
    if (w <= width) { newline(); cur += piece; curW = w; return }
    for (const ch of piece) {
      const cw = wrapUnits(ch)
      if (curW + cw > width) newline()
      cur += ch; curW += cw
    }
  }
  for (const tok of s.split(TAG_RE)) {
    if (!tok) continue
    if (TAG_RE.test(tok)) {
      if (tok === '{open}' || tok === '{close}') emit(tok, 1)
      else { cur += tok; track(tok) }
      continue
    }
    for (const piece of tok.split(/(\s+)/)) {
      if (!piece) continue
      if (/^\s+$/.test(piece)) { if (curW + piece.length <= width) { cur += piece; curW += piece.length } else newline(); continue }
      emit(piece, wrapUnits(piece))
    }
  }
  if (cur !== start || !lines.length) lines.push(cur.replace(/\s+$/, ''))
  return lines
}

/** Right-aligns a line with tags to the right edge of `width` cells. */
/** Graphemes of a text (what the user sees as one character: emoji with skin tone, flag, accented letter). */
export function graphemes(s: string): string[] {
  return Array.from(new Intl.Segmenter().segment(s), g => g.segment)
}

/**
 * Wraps raw text (already in graphemes, without tags) into lines of width ≤ `width`, by words (or by characters
 * when the word doesn't fit). Unlike wrapTagged, nothing is dropped: each grapheme lands on a line and column, so the
 * cursor and mouse can be mapped. Spaces stay at the end of the line where they were, and move to the next one if they don't fit.
 */
export function wrapChars(chars: string[], width: number): string[][] {
  const lines: string[][] = [[]]
  let curW = 0
  const cw = (c: string) => wrapWidth(esc(c))
  const push = (ch: string, w: number) => {
    if (curW > 0 && curW + w > width) { lines.push([]); curW = 0 }
    lines[lines.length - 1]!.push(ch); curW += w
  }
  for (let i = 0; i < chars.length;) {
    // Explicit end of line: stays on the line (zero width) and the next one starts empty.
    if (chars[i] === '\n') { lines[lines.length - 1]!.push('\n'); lines.push([]); curW = 0; i++; continue }
    // A space that no longer fits closes the line and stays on it (invisible at the end), so the next one doesn't start with it.
    if (/^\s$/.test(chars[i]!)) {
      if (curW + 1 > width) { lines[lines.length - 1]!.push(chars[i]!); lines.push([]); curW = 0 } else push(chars[i]!, 1)
      i++; continue
    }
    let j = i, w = 0
    while (j < chars.length && !/^\s$/.test(chars[j]!)) w += cw(chars[j++]!)
    if (curW > 0 && curW + w > width && w <= width) { lines.push([]); curW = 0 }
    for (; i < j; i++) push(chars[i]!, cw(chars[i]!))
  }
  return lines
}

/**
 * Spaces that bring `s` up to `width` cells without blessed wrapping the line: blessed's own measure
 * (`wrapWidth`) may go one past `width` before it wraps, so a line with one emoji still reaches the edge; with
 * more, each further one costs a column.
 */
export function padding(s: string, width: number): number {
  return Math.max(0, Math.min(width - visibleWidth(s), width + 1 - wrapWidth(s)))
}

/** Right-aligns to `width` columns, as far as `padding` allows. */
export function alignRight(s: string, width: number): string {
  return ' '.repeat(padding(s, width)) + s
}

/** For comparing without accents or case: "Ferrão" and "ferrao" match. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}
