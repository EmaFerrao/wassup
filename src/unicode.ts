import blessed from 'blessed'

/**
 * As tabelas Unicode do blessed são de 2015 e só conhecem largura dupla nos blocos CJK: para ele qualquer emoji tem
 * largura 1, o terminal desenha-o com 2 células, e a partir daí a grelha fica desalinhada e aparece lixo. Aqui
 * remenda-se o módulo `unicode` do blessed para contar os emojis de apresentação como largura 2, que é o que os
 * terminais fazem (wcwidth).
 */
interface BlessedUnicode {
  charWidth: (str: string | number, i?: number) => number
  chars: { all: RegExp; wide: RegExp; swide: RegExp }
}

const EMOJI_WIDE = /\p{Emoji_Presentation}/u

export function patchBlessedUnicode() {
  const u = (blessed as unknown as { unicode: BlessedUnicode }).unicode
  if ((u as { _waPatched?: boolean })._waPatched) return
  ;(u as { _waPatched?: boolean })._waPatched = true

  const orig = u.charWidth
  u.charWidth = (str, i) => {
    const cp = typeof str === 'number' ? str : str.codePointAt(i ?? 0)
    if (cp != null && cp > 0xff && EMOJI_WIDE.test(String.fromCodePoint(cp))) return 2
    return orig.call(u, str, i)
  }

  // chars.all é o que o parseContent usa para marcar a segunda célula de cada carácter largo. Reconstrói-se em modo
  // `u`, com os planos CJK por código e os emojis por propriedade.
  u.chars.all = new RegExp(`(\\p{Emoji_Presentation}|[\\u{20000}-\\u{2FFFD}\\u{30000}-\\u{3FFFD}]|${u.chars.wide.source})`, 'gu')
}

/**
 * Sequências que os terminais medem de forma imprevisível (ZWJ, tons de pele, bandeiras) reduzem-se a algo de largura
 * conhecida: o primeiro emoji da sequência, o emoji sem tom, e `[PT]` em vez da bandeira.
 */
export function tameEmoji(s: string): string {
  return s
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '')
    .replace(/(\p{Extended_Pictographic}️?)(?:‍\p{Extended_Pictographic}️?)+/gu, '$1')
    .replace(/\p{Regional_Indicator}\p{Regional_Indicator}/gu, m => `[${[...m].map(c => String.fromCodePoint(c.codePointAt(0)! - 0x1F1E6 + 65)).join('')}]`)
}
