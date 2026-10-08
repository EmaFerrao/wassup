import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHunspellFromFiles } from 'hunspell-wasm'
import { store } from './db.js'
import { fold } from './format.js'
import { lang } from './i18n.js'
import { URL_RE } from './links.js'
import type { Fix } from './llm.js'
import { logger } from './log.js'

/**
 * A small local spell checker, for when there's no model to ask (WA_LLM=off, or no server answering): Hunspell in
 * WebAssembly (hunspell-wasm) with LibreOffice's dictionaries for Portuguese of Portugal and English (GB and US, as
 * npm's dictionary-* packages), a word being right in any of them, so a message mixing both is fine. It only sees
 * words, one at a time: a real word in the wrong place ("as 8" for "às 8") is the model's to catch.
 */

type Hunspell = Awaited<ReturnType<typeof createHunspellFromFiles>>

/** The user's language first: its dictionary's suggestions win ties. */
const DICTIONARIES = lang === 'pt' ? ['dictionary-pt-pt', 'dictionary-en-gb', 'dictionary-en'] : ['dictionary-en-gb', 'dictionary-en', 'dictionary-pt-pt']

let checkers: Promise<Hunspell[]> | undefined
function load(): Promise<Hunspell[]> {
  checkers ??= (async () => {
    const out: Hunspell[] = []
    for (const pkg of DICTIONARIES) {
      try {
        const dir = path.dirname(fileURLToPath(import.meta.resolve(pkg)))
        out.push(await createHunspellFromFiles(path.join(dir, 'index.aff'), path.join(dir, 'index.dic')))
      } catch (e) {
        logger.warn({ e: String(e), pkg }, 'spell: dictionary')
      }
    }
    return out
  })()
  return checkers
}

const WORD = /[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu

let own: Set<string> | undefined
/**
 * Words taken as right whatever the dictionaries say, in lower case: those I wrote myself more than once (slang,
 * abbreviations, names: "bjs", "tou"), and the words of contacts' and chats' names.
 */
function ownWords(): Set<string> {
  if (own) return own
  const count = new Map<string, number>()
  for (const text of store.myTexts()) for (const w of text.match(WORD) ?? []) { const k = w.toLowerCase(); count.set(k, (count.get(k) ?? 0) + 1) }
  own = new Set([...count].filter(([, n]) => n > 1).map(([w]) => w))
  for (const name of store.names()) for (const w of name.match(WORD) ?? []) own.add(w.toLowerCase())
  return own
}

/** Edit distance where two neighbouring letters swapped count as one edit ("recieve" is one from "receive"). */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i ? (j ? 0 : i) : j)))
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1)
    }
  }
  return d[a.length]![b.length]!
}

const best = new Map<string, string | null>()

/**
 * What a word unknown to every dictionary should be, or null to leave it be: the suggestions of all of them, the
 * one equal but for accents first ("nao" → "não"), then the closest (distance, accents aside), then the
 * dictionaries' own order. A word of mine (ownWords) is left be, unless an accent is all it lacks; one that differs
 * only in capitals ("ok" for "OK") too.
 */
function correction(word: string, dicts: Hunspell[]): string | null {
  const known = best.get(word)
  if (known !== undefined) return known
  const f = fold(word)
  const ranked = dicts.flatMap(d => d.getSpellingSuggestions(word)).filter(s => s && s !== word)
    .map((s, i) => ({ s, k: [fold(s) === f ? 0 : 1, distance(f, fold(s)), i] }))
    .sort((a, b) => a.k[0]! - b.k[0]! || a.k[1]! - b.k[1]! || a.k[2]! - b.k[2]!)
  let out: string | null = ranked[0]?.s ?? null
  if (out && fold(out) !== f && ownWords().has(word.toLowerCase())) out = null
  if (out && out.toLowerCase() === word.toLowerCase()) out = null
  // As it was written: a capital at the start stays.
  if (out && /^\p{Lu}/u.test(word) && /^\p{Ll}/u.test(out)) out = out[0]!.toUpperCase() + out.slice(1)
  if (best.size > 5000) best.clear()
  best.set(word, out)
  return out
}

/**
 * The finished words of a text no dictionary knows, each with its correction (correction), in the text's order, up
 * to eight. Left alone: the word still being typed at the end, links and addresses, @mentions, words with digits,
 * all-capital ones (acronyms), single letters, and a hyphenated word whose every part is known ("diz-me").
 */
export async function spellFixes(text: string): Promise<Fix[]> {
  const dicts = await load()
  if (!dicts.length) return []
  const ok = (w: string) => dicts.some(d => d.testSpelling(w))
  const skip: [number, number][] = [...text.matchAll(URL_RE)].map(m => [m.index, m.index + m[0].length])
  for (const m of text.matchAll(/\S*@\S*/g)) skip.push([m.index, m.index + m[0].length])
  const fixes: Fix[] = []
  for (const m of text.matchAll(WORD)) {
    if (fixes.length >= 8) break
    const word = m[0].replace(/['’-]+$/, ''), start = m.index, end = start + word.length
    if (end === text.length) continue
    if (word.length < 2 || word === word.toUpperCase() || /\d/.test(text.slice(start - 1, end + 1))) continue
    if (skip.some(([a, b]) => start < b && a < end)) continue
    if (ok(word) || (word.includes('-') && word.split('-').every(p => !p || ok(p)))) continue
    const to = correction(word, dicts)
    if (to) fixes.push({ from: word, to, start, end })
  }
  return fixes
}
