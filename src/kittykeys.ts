/**
 * Protocolo de teclado do Kitty (Kitty, Ghostty, foot, WezTerm…), só com a bandeira 1, "desambiguar": o terminal passa
 * a distinguir Backspace de Shift+Backspace, Esc de Alt+tecla, etc. O preço é que o Esc, as combinações com Ctrl e Alt
 * e as teclas do teclado numérico chegam como `CSI código;modificadores u`, que o blessed não conhece e deixaria
 * passar como texto. Por isso lêem-se os bytes antes dele e traduzem-se para os eventos keypress que ele espera.
 *
 * A pilha de bandeiras é do ecrã alternativo: empurra-se depois do blessed o abrir e tira-se antes de ele o fechar.
 */
import { logger } from './log.js'

const ENABLE = '\x1b[>1u'
const DISABLE = '\x1b[<u'
const CSI_U = /\x1b\[(\d+)(?::\d+)*(?:;(\d+)(?::\d+)*)?u/g

interface Key { name?: string; ctrl: boolean; meta: boolean; shift: boolean; sequence: string }

/** Teclas funcionais com código próprio no protocolo, pelos nomes que o blessed lhes dá. */
const NAMED: Record<number, string> = {
  27: 'escape', 13: 'return', 9: 'tab', 127: 'backspace', 32: 'space',
  57414: 'return', 57417: 'left', 57418: 'right', 57419: 'up', 57420: 'down', 57421: 'pageup', 57422: 'pagedown',
  57423: 'home', 57424: 'end', 57425: 'insert', 57426: 'delete',
}
/** Teclado numérico que é texto. */
const KEYPAD_TEXT: Record<number, string> = {
  57399: '0', 57400: '1', 57401: '2', 57402: '3', 57403: '4', 57404: '5', 57405: '6', 57406: '7', 57407: '8', 57408: '9',
  57409: '.', 57410: '/', 57411: '*', 57412: '-', 57413: '+', 57415: '=', 57416: ',',
}
const SEQ: Record<string, string> = { return: '\r', tab: '\t', backspace: '\x7f', escape: '\x1b', space: ' ' }

/** Traduz um `CSI u` para (ch, key) do blessed; null para teclas que não têm equivalente (Caps Lock, modificadores…). */
export function translate(code: number, mods: number): [string | undefined, Key] | null {
  const m = mods - 1
  const key: Key = { ctrl: !!(m & 4), meta: !!(m & 2), shift: !!(m & 1), sequence: '' }
  const named = NAMED[code]
  if (named) { key.name = named; key.sequence = SEQ[named] ?? ''; return [key.name === 'space' ? ' ' : undefined, key] }
  const ch = KEYPAD_TEXT[code] ?? (code < 57344 ? String.fromCodePoint(code) : null)
  if (ch == null) return null
  key.sequence = ch
  if (/^[a-z0-9]$/i.test(ch)) { key.name = ch.toLowerCase(); if (ch !== key.name) key.shift = true }
  return [ch, key]
}

type Input = NodeJS.ReadStream & { emit: (event: string, ...args: unknown[]) => boolean }

/** Liga o protocolo e intercepta o stdin do blessed; devolve a função que o desliga. */
export function enableKittyKeyboard(input: Input, write: (s: string) => void): () => void {
  const emit = input.emit.bind(input)
  input.emit = (event: string, ...args: unknown[]) => {
    if (event !== 'data' || !Buffer.isBuffer(args[0])) return emit(event, ...args)
    const s = args[0].toString('latin1')
    if (!s.includes('\x1b[')) return emit(event, ...args)
    let last = 0, handled = true
    for (const m of s.matchAll(CSI_U)) {
      if (m.index > last) handled = emit('data', Buffer.from(s.slice(last, m.index), 'latin1')) && handled
      last = m.index + m[0].length
      const t = translate(Number(m[1]), Number(m[2] ?? '1'))
      if (!t) { logger.info({ seq: JSON.stringify(m[0]) }, 'tecla CSI u sem tradução'); continue }
      emit('keypress', t[0], t[1])
    }
    if (last < s.length) handled = emit('data', Buffer.from(s.slice(last), 'latin1')) && handled
    return handled
  }
  write(ENABLE)
  return () => { write(DISABLE); input.emit = emit }
}
