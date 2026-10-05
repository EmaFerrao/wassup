/**
 * Sondagem das capacidades do terminal, feita antes do blessed tomar conta do stdin. Nada aqui se assume pelo
 * nome do TERM: pergunta-se ao terminal e lê-se a resposta.
 *
 * A ordem importa: só se envia uma sequência depois de haver razão para crer que o terminal a entende. Sequências
 * CSI desconhecidas são ignoradas em silêncio por qualquer terminal; uma APC (como a consulta gráfica do Kitty) não,
 * e há terminais que a imprimem como texto. Por isso a consulta gráfica só sai depois de o terminal se identificar
 * (XTVERSION) como um dos que falam o protocolo.
 */
export interface TermCaps {
  /** Protocolo gráfico do Kitty (Ghostty, Kitty, WezTerm…): confirmado por resposta à consulta a=q. */
  kittyGraphics: boolean
  /** A localização declara UTF-8, logo as molduras podem ser desenhadas com caracteres de caixa Unicode. */
  utf8: boolean
  /** O terminal respondeu ao pedido de identificação (DA1): é interactivo e lê sequências de controlo. */
  answersQueries: boolean
  /** Nome e versão devolvidos pelo XTVERSION (`CSI > 0 q`), se o terminal o suportar. */
  version: string | null
}

const DA1_RE = /\x1b\[\?[\d;]*c/
const XTVERSION_RE = /\x1bP>\|([^\x1b]*)\x1b\\/
const KITTY_OK_RE = /\x1b_Gi=31;OK\x1b\\/
/** Terminais cuja identificação XTVERSION nos autoriza a enviar a consulta gráfica do Kitty. */
const KITTY_TERMS = /ghostty|kitty|wezterm|konsole/i

function localeIsUtf8(): boolean {
  const l = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || ''
  return /utf-?8/i.test(l)
}

/**
 * Escreve `query` seguida de um DA1 (`CSI c`) e devolve o que o terminal respondeu até ao DA1, que todos os terminais
 * respondem e serve de marca de fim. Sem resposta em `timeoutMs`, devolve o que houver (ou nada).
 */
function ask(query: string, timeoutMs: number): Promise<string> {
  const stdin = process.stdin, stdout = process.stdout
  return new Promise(resolve => {
    let buf = ''
    const wasRaw = stdin.isRaw
    const finish = () => {
      clearTimeout(timer)
      stdin.removeListener('data', onData)
      stdin.setRawMode(wasRaw ?? false)
      stdin.pause()
      resolve(buf)
    }
    const onData = (d: Buffer) => {
      buf += d.toString('latin1')
      if (DA1_RE.test(buf)) finish()
    }
    const timer = setTimeout(finish, timeoutMs)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
    stdout.write(`${query}\x1b[c`)
  })
}

export async function probeTerminal(timeoutMs = 600): Promise<TermCaps> {
  const caps: TermCaps = { kittyGraphics: false, utf8: localeIsUtf8(), answersQueries: false, version: null }
  if (!process.stdin.isTTY || !process.stdout.isTTY) return caps

  // 1. Identificação: XTVERSION (CSI, inofensiva) e DA1.
  const first = await ask('\x1b[>0q', timeoutMs)
  caps.answersQueries = DA1_RE.test(first)
  caps.version = XTVERSION_RE.exec(first)?.[1]?.trim() ?? null
  if (!caps.answersQueries) return caps

  // 2. Consulta gráfica do Kitty (APC, id 31, imagem de 1×1 px), só a quem se identificou como capaz.
  if (caps.version && KITTY_TERMS.test(caps.version)) {
    const second = await ask('\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\', timeoutMs)
    caps.kittyGraphics = KITTY_OK_RE.test(second)
  }
  return caps
}
