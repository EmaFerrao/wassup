/**
 * Italic in blessed, which only knows bold, underline, blink, inverse and invisible. Each cell's attributes live
 * in a bitmask with free space: here bit 32 becomes italic. Three of the screen's functions that touch attributes
 * are patched: the one that reads ANSI sequences from content, the one that writes them back, and the renderer,
 * which is rebuilt from its own source code with the italic line added (it only uses two module-level variables,
 * which get injected). If blessed's source code isn't in the expected shape, italic simply has no effect and
 * nothing else is lost. In content, ESC[3m … ESC[23m is written, just like chalk does.
 */
import blessed from 'blessed'
import { logger } from './log.js'

const ITALIC = 32 << 18

interface ScreenProto {
  attrCode: (code: string, cur: number, def: number) => number
  codeAttr: (code: number) => string
  draw: (start: number, end: number) => void
  _italicPatched?: boolean
}

/** Box-drawing characters that blessed's renderer treats specially right after a wide character. */
const ANGLES: Record<string, boolean> = Object.fromEntries([...'┘┐┌└┼├┤┴┬│─'].map(c => [c, true]))

export function patchBlessedItalic(screen: blessed.Widgets.Screen) {
  const proto = Object.getPrototypeOf(screen) as ScreenProto
  if (proto._italicPatched) return
  proto._italicPatched = true

  const attrCode = proto.attrCode
  proto.attrCode = function (this: unknown, code: string, cur: number, def: number) {
    // Separate 3/23 from the rest: 3 turns it on, 23 turns it off, and the codes that reset attributes in blessed
    // also turn it off. A "3" used as a color parameter (38;5;3) doesn't count.
    const parts = code.slice(2, -1).split(';')
    if (!parts[0]) parts[0] = '0'
    let italic = (cur & ITALIC) !== 0
    const rest: string[] = []
    for (let i = 0; i < parts.length; i++) {
      const c = +parts[i]! || 0
      if (c === 3) { italic = true; continue }
      if (c === 23) { italic = false; continue }
      if (c === 0 || c === 22 || c === 24 || c === 25 || c === 27 || c === 28) italic = false
      rest.push(parts[i]!)
      if ((c === 38 || c === 48) && (parts[i + 1] === '5' || parts[i + 1] === '2')) {
        const n = parts[i + 1] === '5' ? 2 : 4
        rest.push(...parts.slice(i + 1, i + 1 + n)); i += n
      }
    }
    // ESC[3m or ESC[23m on its own leaves nothing else to read: passed on as ESC[m, blessed would take it as a reset
    // and drop the colour around it.
    const out = rest.length ? attrCode.call(this, `\x1b[${rest.join(';')}m`, cur & ~ITALIC, def) : cur
    return italic ? out | ITALIC : out & ~ITALIC
  }

  const codeAttr = proto.codeAttr
  proto.codeAttr = function (this: unknown, code: number) {
    const out = codeAttr.call(this, code & ~ITALIC)
    return code & ITALIC ? out.replace('\x1b[', '\x1b[3;') : out
  }

  const src = proto.draw.toString()
  const anchor = "if (flags & 16) {\n            out += '8;';\n          }"
  if (!src.includes(anchor)) { logger.warn('blessed: renderer not in the expected shape; italic disabled'); return }
  const patched = src.replace(anchor, `${anchor}\n          if (flags & 32) {\n            out += '3;';\n          }`)
  const unicode = (blessed as unknown as { unicode: unknown }).unicode
  proto.draw = new Function('unicode', 'angles', `return ${patched}`)(unicode, ANGLES) as ScreenProto['draw']
}
