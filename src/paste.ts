/**
 * Colagem com parênteses (bracketed paste, modo 2004): o terminal embrulha o texto colado em `ESC[200~ … ESC[201~`.
 * Sem isto o texto chega como teclas soltas: os fins de linha ou se perdem ou, nos terminais que os mandam como
 * Enter, enviam uma mensagem por linha. Lêem-se os bytes antes do blessed e o bloco inteiro sai como uma só tecla
 * "paste", com o texto em `ch`. O bloco pode chegar partido em vários pacotes, até a meio das sequências.
 */
const ENABLE = '\x1b[?2004h'
const DISABLE = '\x1b[?2004l'
const START = '\x1b[200~'
const END = '\x1b[201~'

type Input = NodeJS.ReadStream & { emit: (event: string, ...args: unknown[]) => boolean }

/** Quantos bytes do fim de `s` são o início de `seq` (sem ser `seq` inteira). */
function partial(s: string, seq: string): number {
  for (let k = Math.min(seq.length - 1, s.length); k > 0; k--) if (s.endsWith(seq.slice(0, k))) return k
  return 0
}

export function enableBracketedPaste(input: Input, write: (s: string) => void): () => void {
  const emit = input.emit.bind(input)
  let pending: string | null = null
  let carry = ''
  input.emit = (event: string, ...args: unknown[]) => {
    if (event !== 'data' || !Buffer.isBuffer(args[0])) return emit(event, ...args)
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
    return handled
  }
  write(ENABLE)
  return () => { write(DISABLE); input.emit = emit }
}
