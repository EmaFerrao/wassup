/**
 * Bracketed paste (mode 2004): the terminal wraps pasted text in `ESC[200~ … ESC[201~`. Without this the text
 * arrives as loose keystrokes: line endings either get lost or, on terminals that send them as Enter, trigger one
 * message per line. The bytes are read before blessed and the whole block comes out as a single "paste" key, with
 * the text in `ch`. The block can arrive split across several packets, even mid-sequence.
 */

/**
 * How long what could be the start of `ESC[200~` waits for the rest before going out as typed: a lone Esc is just
 * that, and a terminal sends the whole sequence at once, so the rest of one comes within this if at all.
 */
const LONE_MS = 50
const ENABLE = '\x1b[?2004h'
const DISABLE = '\x1b[?2004l'
const START = '\x1b[200~'
const END = '\x1b[201~'

type Input = NodeJS.ReadStream & { emit: (event: string, ...args: unknown[]) => boolean }

/** How many bytes at the end of `s` are the start of `seq` (without being the whole of `seq`). */
function partial(s: string, seq: string): number {
  for (let k = Math.min(seq.length - 1, s.length); k > 0; k--) if (s.endsWith(seq.slice(0, k))) return k
  return 0
}

export function enableBracketedPaste(input: Input, write: (s: string) => void): () => void {
  const emit = input.emit.bind(input)
  let pending: string | null = null
  let carry = ''
  let lone: NodeJS.Timeout | undefined
  input.emit = (event: string, ...args: unknown[]) => {
    if (event !== 'data' || !Buffer.isBuffer(args[0])) return emit(event, ...args)
    if (lone) { clearTimeout(lone); lone = undefined }
    let s = carry + args[0].toString('latin1')
    carry = ''
    let handled = true
    while (s) {
      if (pending == null) {
        const i = s.indexOf(START)
        if (i < 0) {
          const keep = partial(s, START)
          if (s.length > keep) handled = emit('data', Buffer.from(s.slice(0, s.length - keep), 'latin1')) && handled
          carry = s.slice(s.length - keep)
          break
        }
        if (i > 0) handled = emit('data', Buffer.from(s.slice(0, i), 'latin1')) && handled
        pending = ''
        s = s.slice(i + START.length)
      } else {
        const i = s.indexOf(END)
        if (i < 0) {
          const keep = partial(s, END)
          pending += s.slice(0, s.length - keep)
          carry = s.slice(s.length - keep)
          break
        }
        pending += s.slice(0, i)
        const text = Buffer.from(pending, 'latin1').toString('utf8').replace(/\r\n?/g, '\n')
        pending = null
        s = s.slice(i + END.length)
        emit('keypress', text, { name: 'paste', sequence: text, ctrl: false, meta: false, shift: false })
      }
    }
    // Kept as the possible start of a paste, with nothing more after LONE_MS it goes out as typed: otherwise a lone
    // Esc would wait for the next key, and only the second Esc would seem to do anything.
    if (carry && pending == null) {
      lone = setTimeout(() => {
        lone = undefined
        const c = carry
        carry = ''
        if (c) emit('data', Buffer.from(c, 'latin1'))
      }, LONE_MS)
    }
    return handled
  }
  write(ENABLE)
  return () => { if (lone) clearTimeout(lone); write(DISABLE); input.emit = emit }
}
