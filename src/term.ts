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
  /** Protocolo de teclado do Kitty: o terminal respondeu à consulta das bandeiras (`CSI ? u`). */
  kittyKeyboard: boolean
  /** Cor do texto por omissão do terminal, em `#rrggbb`, se respondeu ao OSC 10. */
  fg: string | null
  /** Cor do fundo por omissão do terminal, em `#rrggbb`, se respondeu ao OSC 11. */
  bg: string | null
}

const DA1_RE = /\x1b\[\?[\d;]*c/
const XTVERSION_RE = /\x1bP>\|([^\x1b]*)\x1b\\/
const KITTY_KBD_RE = /\x1b\[\?\d+u/
const KITTY_OK_RE = /\x1b_Gi=31;OK\x1b\\/
/** Resposta ao OSC 10/11: `OSC 1x ; rgb:rrrr/gggg/bbbb ST`, com 1 a 4 dígitos por componente. */
const OSC_COLOR_RE = /\x1b\](1[01]);rgba?:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/gi
/** Terminais cuja identificação XTVERSION nos autoriza a enviar a consulta gráfica do Kitty. */
const KITTY_TERMS = /ghostty|kitty|wezterm|konsole/i

/** Um componente de 1 a 4 dígitos hexadecimais (escala 0..16^n-1) reduzido a dois dígitos. */
function hex2(c: string): string {
  const v = Math.round(parseInt(c, 16) / (16 ** c.length - 1) * 255)
  return v.toString(16).padStart(2, '0')
}

/** As cores de texto (OSC 10) e de fundo (OSC 11) encontradas numa resposta, em `#rrggbb`. */
export function parseColors(answer: string): { fg: string | null; bg: string | null } {
  const out = { fg: null as string | null, bg: null as string | null }
  for (const m of answer.matchAll(OSC_COLOR_RE)) {
    const hex = `#${hex2(m[2]!)}${hex2(m[3]!)}${hex2(m[4]!)}`
    if (m[1] === '10') out.fg = hex; else out.bg = hex
  }
  return out
}

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
  const caps: TermCaps = { kittyGraphics: false, utf8: localeIsUtf8(), answersQueries: false, version: null, kittyKeyboard: false, fg: null, bg: null }
  if (!process.stdin.isTTY || !process.stdout.isTTY) return caps

  // 1. Identificação: XTVERSION e consulta do protocolo de teclado do Kitty (CSI, inofensivas) e DA1.
  const first = await ask('\x1b[>0q\x1b[?u', timeoutMs)
  caps.kittyKeyboard = KITTY_KBD_RE.test(first)
  caps.answersQueries = DA1_RE.test(first)
  caps.version = XTVERSION_RE.exec(first)?.[1]?.trim() ?? null
  if (!caps.answersQueries) return caps

  // 2. Cores por omissão do texto e do fundo (OSC 10 e 11): só a quem já respondeu, e um OSC que o terminal não
  // conheça é engolido sem resposta. Quem não responder fica sem cores conhecidas, e a interface usa só as do tema.
  Object.assign(caps, parseColors(await ask('\x1b]10;?\x1b\\\x1b]11;?\x1b\\', timeoutMs)))

  // 3. Consulta gráfica do Kitty (APC, id 31, imagem de 1×1 px), só a quem se identificou como capaz.
  if (caps.version && KITTY_TERMS.test(caps.version)) {
    const second = await ask('\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\', timeoutMs)
    caps.kittyGraphics = KITTY_OK_RE.test(second)
  }
  return caps
}
