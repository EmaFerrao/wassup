/**
 * Itálico no blessed, que só conhece negrito, sublinhado, piscar, inverso e invisível. Os atributos de cada célula
 * vivem numa máscara de bits com espaço livre: aqui o bit 32 passa a ser o itálico. Remendam-se as três funções do
 * ecrã que tocam nos atributos: a que lê sequências ANSI do conteúdo, a que as volta a escrever, e o desenho, que é
 * reconstruído a partir do próprio código fonte com a linha do itálico acrescentada (usa só duas variáveis de
 * módulo, que se injectam). Se o código fonte do blessed não for o esperado, o itálico fica sem efeito e nada mais
 * se perde. No conteúdo escreve-se ESC[3m … ESC[23m, como o chalk.
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

/** Caracteres de caixa que o desenho do blessed trata de modo especial a seguir a um carácter largo. */
const ANGLES: Record<string, boolean> = Object.fromEntries([...'┘┐┌└┼├┤┴┬│─'].map(c => [c, true]))

export function patchBlessedItalic(screen: blessed.Widgets.Screen) {
  const proto = Object.getPrototypeOf(screen) as ScreenProto
  if (proto._italicPatched) return
  proto._italicPatched = true

  const attrCode = proto.attrCode
  proto.attrCode = function (this: unknown, code: string, cur: number, def: number) {
    // Separar o 3/23 do resto: 3 liga, 23 desliga, e os códigos que no blessed repõem os atributos também desligam.
    // Um "3" como parâmetro de cor (38;5;3) não conta.
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
    const out = attrCode.call(this, `\x1b[${rest.join(';')}m`, cur & ~ITALIC, def)
    return italic ? out | ITALIC : out & ~ITALIC
  }

  const codeAttr = proto.codeAttr
  proto.codeAttr = function (this: unknown, code: number) {
    const out = codeAttr.call(this, code & ~ITALIC)
    return code & ITALIC ? out.replace('\x1b[', '\x1b[3;') : out
  }

  const src = proto.draw.toString()
  const anchor = "if (flags & 16) {\n            out += '8;';\n          }"
  if (!src.includes(anchor)) { logger.warn('blessed: desenho sem a forma esperada; sem itálico'); return }
  const patched = src.replace(anchor, `${anchor}\n          if (flags & 32) {\n            out += '3;';\n          }`)
  const unicode = (blessed as unknown as { unicode: unknown }).unicode
  proto.draw = new Function('unicode', 'angles', `return ${patched}`)(unicode, ANGLES) as ScreenProto['draw']
}

export function italic(s: string): string {
  return `\x1b[3m${s}\x1b[23m`
}
