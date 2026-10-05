/**
 * Sugestões de escrita por um modelo local (llama-server, API compatível com a da OpenAI), só de duas espécies: a
 * palavra que está a meio no cursor, completa ou corrigida, e a correcção de uma palavra errada já escrita na frase.
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
  /** Palavra já terminada que o modelo dá por errada, tal como está no texto, e a correcção. */
  fix: { from: string; to: string } | null
}

const SYSTEM = `Ajudas a escrever mensagens de WhatsApp em português de Portugal (ortografia europeia). Recebes a conversa recente e o texto em curso, que termina onde está o cursor.
Responde só com JSON: {"word": "...", "wrong": "...", "fix": "..."}.
- "word": se o texto em curso acabar a meio de uma palavra, essa palavra inteira, como deve ficar escrita (completa-a; se o que está escrito tiver erro, dá a forma certa); senão "". Uma palavra só, sem espaços. Escolhe pelo tom e assunto da conversa.
- "wrong" e "fix": se alguma palavra já terminada do texto em curso tiver erro ortográfico ou acento em falta, essa palavra exactamente como está escrita e a sua correcção; senão ambas "". Uma palavra de cada vez, a mais à direita. Não mudes nomes próprios, estrangeirismos nem abreviaturas correntes.`

const SCHEMA = {
  type: 'object',
  properties: { word: { type: 'string', maxLength: 40 }, wrong: { type: 'string', maxLength: 40 }, fix: { type: 'string', maxLength: 40 } },
  required: ['word', 'wrong', 'fix'],
  additionalProperties: false,
}

const WORD = /[\p{L}\p{M}'-]+/gu
const PARTIAL = /[\p{L}\p{M}'-]+$/u

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
  const f = fold(from), t = fold(to)
  if (t.startsWith(f)) return t.length > f.length || to !== from
  if (f.length < 3) return false
  return levenshtein(f, t.slice(0, f.length)) <= Math.max(1, Math.floor(f.length / 4))
}

/** A palavra a meio no fim do texto, se o texto acabar numa letra. */
export function partialWord(text: string): string | null {
  return PARTIAL.exec(text)?.[0] ?? null
}

/**
 * Onde está, no texto, a palavra que o modelo diz estar errada: a última ocorrência inteira, nunca a palavra ainda a
 * meio no fim. Devolve o intervalo em unidades de código, ou null se não existir assim.
 */
export function locateWord(text: string, word: string): { start: number; end: number } | null {
  const atEnd = PARTIAL.test(text)
  let found: { start: number; end: number } | null = null
  for (const m of text.matchAll(WORD)) {
    const end = m.index + m[0].length
    if (atEnd && end === text.length) break
    if (m[0] === word) found = { start: m.index, end }
  }
  return found
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
  // Só palavras feitas de letras: o modelo às vezes devolve aspas, pontuação ou o fim do texto colado.
  const str = (v: unknown) => (typeof v === 'string' && /^[\p{L}\p{M}'-]+$/u.test(v.trim()) ? v.trim() : '')
  const partial = partialWord(text)
  const wordTo = str(parsed.word)
  const word = partial && wordTo && wordTo !== partial && !/\s/.test(wordTo) && plausibleWord(partial, wordTo) ? { from: partial, to: wordTo } : null
  const wrong = str(parsed.wrong), fixTo = str(parsed.fix)
  const fix = wrong && fixTo && fixTo !== wrong && !/\s/.test(fixTo) && locateWord(text, wrong) ? { from: wrong, to: fixTo } : null
  return word || fix ? { word, fix } : null
}
