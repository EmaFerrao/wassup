import blessed from 'blessed'

/**
 * blessed's Unicode tables date from 2015 and only know double width for CJK blocks: to it any emoji has width 1,
 * the terminal draws it with 2 cells, and from there the grid gets misaligned and garbage shows up. Here blessed's
 * `unicode` module is patched to count emoji-presentation characters as width 2, which is what terminals do
 * (wcwidth). Same for a text pictograph followed by the U+FE0F variation selector ("❤️", "✔️"): the selector asks
 * for the emoji form, which the terminal draws with 2 cells; blessed saw it as a width-0 combining character over
 * a width-1 character, and each one left a column of garbage to the right.
 */
interface BlessedUnicode {
  charWidth: (str: string | number, i?: number) => number
  chars: { all: RegExp; wide: RegExp; swide: RegExp }
}

const EMOJI_WIDE = /\p{Emoji_Presentation}/u
const PICTOGRAPH = /\p{Extended_Pictographic}/u
const VS16 = '\uFE0F'

export function patchBlessedUnicode() {
  const u = (blessed as unknown as { unicode: BlessedUnicode }).unicode
  if ((u as { _waPatched?: boolean })._waPatched) return
  ;(u as { _waPatched?: boolean })._waPatched = true

  const orig = u.charWidth
  u.charWidth = (str, i) => {
    const at = i ?? 0
    const cp = typeof str === 'number' ? str : str.codePointAt(at)
    if (cp == null || cp <= 0xff) return orig.call(u, str, i)
    const c = String.fromCodePoint(cp)
    if (EMOJI_WIDE.test(c)) return 2
    // blessed's renderer merges the U+FE0F into the previous character's cell, so here it comes right after it.
    if (typeof str !== 'number' && str[at + c.length] === VS16 && PICTOGRAPH.test(c)) return 2
    return orig.call(u, str, i)
  }

  // chars.all is what parseContent uses to mark the second cell of each wide character. It's rebuilt in `u` mode,
  // with the CJK planes by code point and emoji by property; the U+FE0F stays inside the sequence so the marker
  // falls after it.
  u.chars.all = new RegExp(`(\\p{Extended_Pictographic}\\uFE0F|\\p{Emoji_Presentation}|[\\u{20000}-\\u{2FFFD}\\u{30000}-\\u{3FFFD}]|${u.chars.wide.source})`, 'gu')
}

/**
 * Sequences that terminals measure unpredictably (ZWJ, skin tones, flags) are reduced to something of known
 * width: the first emoji in the sequence, the emoji without its tone, and `[PT]` instead of the flag.
 */
export function tameEmoji(s: string): string {
  return s
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '')
    .replace(/(\p{Extended_Pictographic}️?)(?:‍\p{Extended_Pictographic}️?)+/gu, '$1')
    .replace(/\p{Regional_Indicator}\p{Regional_Indicator}/gu, m => `[${[...m].map(c => String.fromCodePoint(c.codePointAt(0)! - 0x1F1E6 + 65)).join('')}]`)
}
