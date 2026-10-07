/**
 * Terminal capability probing, done before blessed takes over stdin. Nothing here is assumed from the TERM
 * name: the terminal is asked and the answer is read.
 *
 * Order matters: a sequence is only sent once there's reason to believe the terminal understands it. Unknown
 * CSI sequences are silently ignored by any terminal; an APC (such as Kitty's graphics query) is not, and some
 * terminals print it as text. That's why the graphics query is only sent after the terminal identifies itself
 * (XTVERSION) as one that speaks the protocol.
 */
export interface TermCaps {
  /** Kitty graphics protocol (Ghostty, Kitty, WezTerm…): confirmed by the reply to the a=q query. */
  kittyGraphics: boolean
  /** The locale declares UTF-8, so frames can be drawn with Unicode box-drawing characters. */
  utf8: boolean
  /** The terminal answered the identification request (DA1): it's interactive and reads control sequences. */
  answersQueries: boolean
  /** Name and version returned by XTVERSION (`CSI > 0 q`), if the terminal supports it. */
  version: string | null
  /** Kitty keyboard protocol: the terminal answered the flags query (`CSI ? u`). */
  kittyKeyboard: boolean
  /** Terminal's default text color, in `#rrggbb`, if it answered OSC 10. */
  fg: string | null
  /** Terminal's default background color, in `#rrggbb`, if it answered OSC 11. */
  bg: string | null
  /** 24-bit colour: the terminal confirmed the RGB or Tc capability (XTGETTCAP), or echoed a 24-bit SGR back (DECRQSS). */
  truecolor: boolean
}

const DA1_RE = /\x1b\[\?[\d;]*c/
const XTVERSION_RE = /\x1bP>\|([^\x1b]*)\x1b\\/
const KITTY_KBD_RE = /\x1b\[\?\d+u/
const KITTY_OK_RE = /\x1b_Gi=31;OK\x1b\\/
/** XTGETTCAP reply confirming RGB or Tc (`DCS 1 + r <hex name>`): `0 + r` would mean the terminal doesn't have it. */
const XTGETTCAP_RGB_RE = /\x1bP1\+r(?:524742|5463)/i
/** DECRQSS reply carrying the 24-bit colour back, in any of the forms terminals write it (`38;2;1;2;3`, `38:2::1:2:3`). */
const DECRQSS_RGB_RE = /\x1bP1\$r[^\x1b]*38[:;]2[:;]+1[:;]2[:;]3/
/** Reply to OSC 10/11: `OSC 1x ; rgb:rrrr/gggg/bbbb ST`, with 1 to 4 digits per component. */
const OSC_COLOR_RE = /\x1b\](1[01]);rgba?:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/gi
/** Terminals whose XTVERSION identification authorizes us to send the Kitty graphics query. */
const KITTY_TERMS = /ghostty|kitty|wezterm|konsole/i

/** A component of 1 to 4 hex digits (scale 0..16^n-1) reduced to two digits. */
function hex2(c: string): string {
  const v = Math.round(parseInt(c, 16) / (16 ** c.length - 1) * 255)
  return v.toString(16).padStart(2, '0')
}

/** The text (OSC 10) and background (OSC 11) colors found in a reply, in `#rrggbb`. */
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
 * Writes `query` followed by a DA1 (`CSI c`) and returns what the terminal answered up to the DA1, which every
 * terminal answers and which serves as an end marker. With no reply within `timeoutMs`, returns whatever there is
 * (or nothing).
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
  const caps: TermCaps = { kittyGraphics: false, utf8: localeIsUtf8(), answersQueries: false, version: null, kittyKeyboard: false, fg: null, bg: null, truecolor: false }
  if (!process.stdin.isTTY || !process.stdout.isTTY) return caps

  // 1. Identification: XTVERSION and Kitty keyboard protocol query (CSI, harmless) and DA1.
  const first = await ask('\x1b[>0q\x1b[?u', timeoutMs)
  caps.kittyKeyboard = KITTY_KBD_RE.test(first)
  caps.answersQueries = DA1_RE.test(first)
  caps.version = XTVERSION_RE.exec(first)?.[1]?.trim() ?? null
  if (!caps.answersQueries) return caps

  // 2. Default text and background colors (OSC 10 and 11): only for terminals that already answered, and an OSC
  // the terminal doesn't know is swallowed without a reply. Whoever doesn't answer is left without known colors,
  // and the UI falls back to the theme's own.
  Object.assign(caps, parseColors(await ask('\x1b]10;?\x1b\\\x1b]11;?\x1b\\', timeoutMs)))

  // 3. 24-bit colour, asked of the terminal itself: XTGETTCAP for the RGB and Tc terminfo capabilities (Herdr,
  // which doesn't answer DECRQSS, confirms both), and DECRQSS on an SGR set to a 24-bit colour, for terminals that
  // answer that one instead. Both are DCS strings, which a terminal that doesn't know them swallows.
  const hex = (s: string) => Buffer.from(s).toString('hex')
  const rgb = await ask(`\x1bP+q${hex('RGB')};${hex('Tc')}\x1b\\\x1b[38;2;1;2;3m\x1bP$qm\x1b\\\x1b[0m`, timeoutMs)
  caps.truecolor = XTGETTCAP_RGB_RE.test(rgb) || DECRQSS_RGB_RE.test(rgb)

  // 4. Kitty graphics query (APC, id 31, 1×1 px image), only for those who identified as capable.
  if (caps.version && KITTY_TERMS.test(caps.version)) {
    const second = await ask('\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\', timeoutMs)
    caps.kittyGraphics = KITTY_OK_RE.test(second)
  }
  return caps
}
