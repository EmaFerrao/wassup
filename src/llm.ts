/**
 * Sugestões de escrita por um modelo local (llama-server, API compatível com a da OpenAI): dada a conversa recente e
 * o texto em curso, devolve a continuação mais provável e, se a última palavra completa tiver erro, a correcção.
 * Desligado com WA_LLM=off; sem servidor a responder, as sugestões simplesmente não aparecem.
 */
import { logger } from './log.js'

const URL = process.env.WA_LLM ?? 'http://127.0.0.1:8080'
const MODEL = process.env.WA_LLM_MODEL ?? 'gemma4-26b'
export const llmEnabled = URL !== 'off' && URL !== ''

export interface Suggestion {
  /** Continuação a inserir no cursor: o resto da palavra actual e até quatro palavras seguintes. */
  next: string
  /** Palavra já escrita que o modelo dá por errada, tal como está no texto, e a correcção. */
  fix: { from: string; to: string } | null
}

const SYSTEM = `Ajudas a escrever mensagens de WhatsApp em português de Portugal (ortografia europeia). Recebes a conversa recente e o texto em curso, que termina onde está o cursor.
Responde só com JSON: {"next": "...", "wrong": "...", "fix": "..."}.
- "next": a continuação mais provável do texto em curso, no tom da conversa: completa a palavra a meio (se houver) e junta no máximo quatro palavras seguintes. Começa por um espaço se a continuação for uma palavra nova. Nunca repitas o que já está escrito.
- "wrong" e "fix": se alguma palavra já terminada do texto em curso tiver erro ortográfico ou acento em falta, essa palavra exactamente como está escrita e a sua correcção; senão ambas "". Uma palavra de cada vez, a mais à direita. Não mudes nomes próprios, estrangeirismos, abreviaturas correntes nem a palavra a meio no fim.`

const SCHEMA = {
  type: 'object',
  properties: { next: { type: 'string', maxLength: 60 }, wrong: { type: 'string', maxLength: 40 }, fix: { type: 'string', maxLength: 40 } },
  required: ['next', 'wrong', 'fix'],
  additionalProperties: false,
}

const WORD = /[\p{L}\p{M}'-]+/gu

/**
 * Onde está, no texto, a palavra que o modelo diz estar errada: a última ocorrência inteira, nunca a palavra ainda a
 * meio no fim. Devolve o intervalo em unidades de código, ou null se não existir assim.
 */
export function locateWord(text: string, word: string): { start: number; end: number } | null {
  const atEnd = /[\p{L}\p{M}'-]$/u.test(text)
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
    `Texto em curso: «${text}»`,
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
  let parsed: { next?: unknown; wrong?: unknown; fix?: unknown }
  try { parsed = JSON.parse(content) } catch { logger.warn({ content }, 'llm: resposta não é JSON'); return null }
  let next = typeof parsed.next === 'string' ? parsed.next.replace(/\s+/g, ' ').trimEnd() : ''
  // O modelo às vezes repete o fim do texto ou abre com espaço depois de um espaço já escrito.
  if (text.endsWith(' ') && next.startsWith(' ')) next = next.trimStart()
  if (next && text.toLowerCase().endsWith(next.trim().toLowerCase())) next = ''
  const wrong = typeof parsed.wrong === 'string' ? parsed.wrong.trim() : ''
  const fixTo = typeof parsed.fix === 'string' ? parsed.fix.trim() : ''
  const fix = wrong && fixTo && fixTo !== wrong && !/\s/.test(fixTo) && locateWord(text, wrong) ? { from: wrong, to: fixTo } : null
  return next || fix ? { next, fix } : null
}
