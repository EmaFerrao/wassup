/**
 * Sugestões de escrita por um modelo local (llama-server, API compatível com a da OpenAI), só de duas espécies: a
 * palavra que está a meio no cursor, completa ou corrigida, e a correcção de uma palavra errada já escrita na frase
 * (ortografia, palavras coladas, palavra trocada numa expressão, gramática).
 * Desligado com WA_LLM=off; sem servidor a responder, as sugestões simplesmente não aparecem.
 */
import { logger } from './log.js'
import { fold } from './format.js'

const URL = process.env.WA_LLM ?? 'http://127.0.0.1:8080'
const MODEL = process.env.WA_LLM_MODEL ?? 'gemma4-26b'
export const llmEnabled = URL !== 'off' && URL !== ''

export interface Suggestion {
  /** A palavra a meio no cursor (`from`, o que está escrito) e a palavra inteira que o modelo propõe (`to`). */
  word: { from: string; to: string } | null
  /**
   * Palavras já terminadas que o modelo dá por erradas, tal como estão no texto, a correcção, e onde estão
   * (unidades de código do texto para que a sugestão foi pedida). Quando o modelo devolve uma expressão inteira
   * ("de vem em quando" → "de vez em quando"), fica só a parte que muda ("vem" → "vez").
   */
  fix: { from: string; to: string; start: number; end: number } | null
}

const SYSTEM = `Ajudas a escrever mensagens de WhatsApp em português de Portugal (ortografia europeia). Recebes a conversa recente e o texto em curso, que termina onde está o cursor.
Responde só com JSON: {"word": "...", "wrong": "...", "fix": "..."}.
- "word": se o texto em curso acabar a meio de uma palavra, essa palavra inteira, como deve ficar escrita (completa-a; se o que está escrito tiver erro, dá a forma certa; se forem duas palavras coladas, separa-as); senão "". Escolhe pelo tom e assunto da conversa.
- "wrong" e "fix": se alguma palavra já terminada do texto em curso tiver erro ortográfico ou acento em falta ("amanha" → "amanhã", "as 8" → "às 8", "nao" → "não"), forem duas palavras coladas sem espaço ("vamosjantar"), for uma palavra trocada por outra parecida que não faz sentido ali ("de vem em quando" → "de vez em quando"), ou houver um erro gramatical (concordância, conjugação, regência: "a gente vamos" → "a gente vai", "houveram problemas" → "houve problemas", "fazem dois anos" → "faz dois anos"), o trecho exactamente como está escrito (o mais curto possível, só as palavras precisas) e a sua correcção; senão ambas "". Um erro de cada vez, o mais à direita. Não mudes nomes próprios, estrangeirismos, abreviaturas correntes, a linguagem informal nem o estilo de quem escreve.`

const SCHEMA = {
  type: 'object',
  properties: { word: { type: 'string', maxLength: 60 }, wrong: { type: 'string', maxLength: 40 }, fix: { type: 'string', maxLength: 60 } },
  required: ['word', 'wrong', 'fix'],
  additionalProperties: false,
}

const PARTIAL = /[\p{L}\p{M}'-]+$/u
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]!
}

/**
 * A palavra proposta para a que está a meio tem de a continuar (sem contar acentos nem maiúsculas) ou, com três
 * letras ou mais escritas, diferir pouco delas — uma gralha, não outra palavra ("e" nunca vira "depois").
 */
export function plausibleWord(from: string, to: string): boolean {
  const f = fold(from), t = fold(to).replace(/ /g, '')
  if (t.startsWith(f)) return t.length > f.length || to !== from
  if (f.length < 3) return false
  return levenshtein(f, t.slice(0, f.length)) <= Math.max(1, Math.floor(f.length / 4))
}

/** A palavra a meio no fim do texto, se o texto acabar numa letra. */
export function partialWord(text: string): string | null {
  return PARTIAL.exec(text)?.[0] ?? null
}

/**
 * Onde está, no texto, a palavra ou expressão que o modelo diz estar errada: a última ocorrência inteira (delimitada
 * por não-letras), nunca a que acaba na palavra ainda a meio no fim. Devolve o intervalo em unidades de código.
 */
export function locateWord(text: string, phrase: string): { start: number; end: number } | null {
  const atEnd = PARTIAL.test(text)
  const re = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}'-])${escapeRe(phrase)}(?![\\p{L}\\p{M}\\p{N}'-])`, 'gu')
  let found: { start: number; end: number } | null = null
  for (const m of text.matchAll(re)) {
    const end = m.index + m[0].length
    if (atEnd && end === text.length) break
    found = { start: m.index, end }
  }
  return found
}

/**
 * Reduz uma correcção de expressão às palavras que mudam: tiram-se as palavras iguais no início e no fim de ambas.
 * "de vem em quando" → "de vez em quando" fica "vem" → "vez", no sítio certo dentro da ocorrência encontrada.
 */
export function narrowFix(text: string, wrong: string, fix: string): Suggestion['fix'] {
  const loc = locateWord(text, wrong)
  return loc && narrowAt(loc, wrong, fix)
}

/**
 * O modelo muitas vezes põe a correcção da palavra ainda a meio no cursor em "wrong"/"fix" em vez de em "word" ("nao" →
 * "não", "esta bem" → "está bem"). Aceita-se quando o trecho errado acaba mesmo no fim do texto, palavra a palavra, e
 * cada palavra corrigida é igual à escrita ou plausível como correcção dela.
 */
export function fixAtEnd(text: string, wrong: string, fix: string): Suggestion['fix'] {
  if (!text.endsWith(wrong)) return null
  const start = text.length - wrong.length
  if (start > 0 && /[\p{L}\p{M}\p{N}'-]/u.test(text[start - 1]!)) return null
  const a = wrong.split(' '), b = fix.split(' ')
  if (a.length !== b.length || !a.every((w, i) => w === b[i] || plausibleWord(w, b[i]!))) return null
  return narrowAt({ start, end: text.length }, wrong, fix)
}

function narrowAt(loc: { start: number; end: number }, wrong: string, fix: string): Suggestion['fix'] {
  const a = wrong.split(' '), b = fix.split(' ')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const from = a.slice(head, a.length - tail).join(' '), to = b.slice(head, b.length - tail).join(' ')
  if (!from || !to || from === to) return null
  const start = loc.start + a.slice(0, head).join(' ').length + (head ? 1 : 0)
  const end = loc.end - a.slice(a.length - tail).join(' ').length - (tail ? 1 : 0)
  return { from, to, start, end }
}

export async function suggest(context: { who: string; text: string }[], text: string, signal: AbortSignal): Promise<Suggestion | null> {
  const user = [
    'Conversa recente:',
    ...context.map(c => `${c.who}: ${c.text.replace(/\s+/g, ' ').slice(0, 200)}`),
    '',
    'Texto em curso (termina no cursor, sem mais nada a seguir):',
    text,
  ].join('\n')
  const body = {
    model: MODEL,
    temperature: 0,
    max_tokens: 48,
    reasoning_effort: 'none',
    chat_template_kwargs: { enable_thinking: false },
    response_format: { type: 'json_schema', json_schema: { name: 'suggestion', schema: SCHEMA } },
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
  }
  const res = await fetch(`${URL}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  if (!res.ok) { logger.warn({ status: res.status }, 'llm'); return null }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  const content = data.choices?.[0]?.message?.content
  if (!content) return null
  let parsed: { word?: unknown; wrong?: unknown; fix?: unknown }
  try { parsed = JSON.parse(content) } catch { logger.warn({ content }, 'llm: resposta não é JSON'); return null }
  // Só palavras feitas de letras ou algarismos, até quatro separadas por um espaço (palavras coladas a separar, expressões): o
  // modelo às vezes devolve aspas, pontuação ou o fim do texto colado.
  const str = (v: unknown) => (typeof v === 'string' && /^[\p{L}\p{M}\p{N}'-]+( [\p{L}\p{M}\p{N}'-]+){0,3}$/u.test(v.trim()) ? v.trim() : '')
  const partial = partialWord(text)
  const wordTo = str(parsed.word)
  const word = partial && wordTo && wordTo !== partial && plausibleWord(partial, wordTo) ? { from: partial, to: wordTo } : null
  const wrong = str(parsed.wrong), fixTo = str(parsed.fix)
  const fix = wrong && fixTo && fixTo !== wrong ? narrowFix(text, wrong, fixTo) ?? (word ? null : fixAtEnd(text, wrong, fixTo)) : null
  return word || fix ? { word, fix } : null
}
