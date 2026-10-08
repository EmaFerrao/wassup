/**
 * Writing suggestions from a local model (llama-server, an OpenAI-compatible API), of only two kinds: the word
 * that's half-typed at the cursor, completed or corrected, and the corrections of the wrong words already written in
 * the sentence (spelling, words stuck together, a word swapped in an expression, grammar, punctuation), all of them.
 * Also a short description of an image, for the selected one when images are drawn in half-blocks, and the reply
 * the chat in front calls for, when there is one, offered in the empty input. Turned off with WA_LLM=off; with no
 * server responding, suggestions, descriptions and replies simply don't appear.
 */
import { logger } from './log.js'
import { fold } from './format.js'
import { lang } from './i18n.js'

const URL = process.env.WA_LLM ?? 'http://127.0.0.1:8080'
const MODEL = process.env.WA_LLM_MODEL ?? 'gemma4-26b'
export const llmEnabled = URL !== 'off' && URL !== ''

export interface Suggestion {
  /** The word half-typed at the cursor (`from`, what's written) and the whole word the model proposes (`to`). */
  word: { from: string; to: string } | null
  /**
   * Finished words the model flags as wrong, exactly as they are in the text, their correction, and where they are
   * (code units of the text the suggestion was requested for), in the text's order, never overlapping. When the model
   * returns a whole expression ("de vem em quando" → "de vez em quando"), only the part that changes is kept
   * ("vem" → "vez").
   */
  fixes: Fix[]
}

export interface Fix { from: string; to: string; start: number; end: number }

const SYSTEM_PT = `Ajudas a escrever mensagens de WhatsApp em português de Portugal (ortografia europeia). Recebes a conversa recente e o texto em curso, que termina onde está o cursor.
Responde só com JSON: {"word": "...", "fixes": [{"wrong": "...", "fix": "..."}]}.
- "word": se o texto em curso acabar a meio de uma palavra, essa palavra inteira, como deve ficar escrita (completa-a; se o que está escrito tiver erro, dá a forma certa; se forem duas palavras coladas, separa-as); senão "". Escolhe pelo tom e assunto da conversa.
- "fixes": por cada erro, se alguma palavra já terminada do texto em curso tiver erro ortográfico ou acento em falta ("amanha" → "amanhã", "as 8" → "às 8", "nao" → "não"), forem duas palavras coladas sem espaço ("vamosjantar"), for uma palavra trocada por outra parecida que não faz sentido ali ("de vem em quando" → "de vez em quando"), ou houver um erro gramatical (concordância, conjugação, regência: "a gente vamos" → "a gente vai", "houveram problemas" → "houve problemas", "fazem dois anos" → "faz dois anos"), ou faltar uma vírgula a seguir a uma saudação ou antes de um vocativo ("Olá gostas de mim?" → "Olá, gostas de mim?", "obrigado Marta" → "obrigado, Marta"), em "wrong" o trecho exactamente como está escrito (o mais curto possível, só as palavras precisas) e em "fix" a sua correcção. Todos os erros, pela ordem do texto, até cinco; sem erros, []. Não mudes nomes próprios, estrangeirismos, abreviaturas correntes, a linguagem informal nem o estilo de quem escreve.`

const SYSTEM_EN = `You help write WhatsApp messages in English. You get the recent conversation and the text being typed, which ends where the cursor is.
Answer only with JSON: {"word": "...", "fixes": [{"wrong": "...", "fix": "..."}]}.
- "word": if the text ends in the middle of a word, that whole word as it should be written (complete it; if what is written has a typo, give the right form; if two words are stuck together, separate them); otherwise "". Choose by the tone and topic of the conversation.
- "fixes": for each error, if some finished word of the text has a spelling error ("tomorow" → "tomorrow", "recieve" → "receive"), two words are stuck together without a space ("letsgo"), a word was swapped for a similar one that makes no sense there ("could of" → "could have", "their going" → "they're going"), or there is a grammar error (agreement, tense: "he don't" → "he doesn't", "we was" → "we were"), or a comma is missing after a greeting or before a name being addressed ("Hi how are you?" → "Hi, how are you?", "thanks John" → "thanks, John"), give in "wrong" the passage exactly as written (as short as possible, only the words needed) and in "fix" its correction. All the errors, in the text's order, up to five; with none, []. Do not change proper names, slang, common abbreviations, informal language or the writer's style.`

const SYSTEM = lang === 'pt' ? SYSTEM_PT : SYSTEM_EN
const LABELS = lang === 'pt'
  ? { recent: 'Conversa recente:', current: 'Texto em curso (termina no cursor, sem mais nada a seguir):' }
  : { recent: 'Recent conversation:', current: 'Text being typed (ends at the cursor, nothing after it):' }

const SCHEMA = {
  type: 'object',
  properties: {
    word: { type: 'string', maxLength: 60 },
    fixes: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: { wrong: { type: 'string', maxLength: 40 }, fix: { type: 'string', maxLength: 60 } },
        required: ['wrong', 'fix'],
        additionalProperties: false,
      },
    },
  },
  required: ['word', 'fixes'],
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
 * The word proposed for the one half-typed must continue it (ignoring accents and case) or, with three or more
 * letters already written, differ little from it — a typo, not another word ("e" never becomes "depois").
 */
export function plausibleWord(from: string, to: string): boolean {
  const f = fold(from), t = fold(to).replace(/ /g, '')
  if (t.startsWith(f)) return t.length > f.length || to !== from
  if (f.length < 3) return false
  return levenshtein(f, t.slice(0, f.length)) <= Math.max(1, Math.floor(f.length / 4))
}

/** The half-typed word at the end of the text, if the text ends on a letter. */
export function partialWord(text: string): string | null {
  return PARTIAL.exec(text)?.[0] ?? null
}

/**
 * Where, in the text, the word or expression the model says is wrong is located: the last whole occurrence
 * (delimited by non-letters), never the one ending in the word still half-typed at the end. Returns the range in code units.
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
 * Narrows an expression correction down to the words that change: the matching words at the start and end of both
 * are stripped. "de vem em quando" → "de vez em quando" becomes "vem" → "vez", at the right spot within the occurrence found.
 */
export function narrowFix(text: string, wrong: string, fix: string): Fix | null {
  const loc = locateWord(text, wrong)
  return loc && narrowAt(loc, wrong, fix)
}

/**
 * The model often puts the correction for the word still half-typed at the cursor into "wrong"/"fix" instead of
 * "word" ("nao" → "não", "esta bem" → "está bem"). This is accepted when the wrong passage ends right at the end of
 * the text, word for word, and each corrected word matches what was written or is plausible as its correction.
 */
export function fixAtEnd(text: string, wrong: string, fix: string): Fix | null {
  if (!text.endsWith(wrong)) return null
  const start = text.length - wrong.length
  if (start > 0 && /[\p{L}\p{M}\p{N}'-]/u.test(text[start - 1]!)) return null
  const a = wrong.split(' '), b = fix.split(' ')
  if (a.length !== b.length || !a.every((w, i) => w === b[i] || plausibleWord(w, b[i]!))) return null
  return narrowAt({ start, end: text.length }, wrong, fix)
}

function narrowAt(loc: { start: number; end: number }, wrong: string, fix: string): Fix | null {
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
    LABELS.recent,
    ...context.map(c => `${c.who}: ${c.text.replace(/\s+/g, ' ').slice(0, 200)}`),
    '',
    LABELS.current,
    text,
  ].join('\n')
  const body = {
    model: MODEL,
    temperature: 0,
    max_tokens: 200,
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
  let parsed: { word?: unknown; fixes?: unknown }
  try { parsed = JSON.parse(content) } catch { logger.warn({ content }, 'llm: response is not JSON'); return null }
  // Only words made of letters or digits, up to four separated by a space (words stuck together to split, expressions): the
  // model sometimes returns quotes, punctuation or the end of the text stuck on. A wrong passage and its fix may also
  // end a word with a comma or another punctuation mark, since a missing comma is one of the errors asked for.
  const str = (v: unknown, punct = false) => {
    if (typeof v !== 'string') return ''
    const t = v.trim()
    return (punct ? /^[\p{L}\p{M}\p{N}'-]+[,;:!?.]?( [\p{L}\p{M}\p{N}'-]+[,;:!?.]?){0,3}$/u : /^[\p{L}\p{M}\p{N}'-]+( [\p{L}\p{M}\p{N}'-]+){0,3}$/u).test(t) ? t : ''
  }
  const partial = partialWord(text)
  const wordTo = str(parsed.word)
  const word = partial && wordTo && wordTo !== partial && plausibleWord(partial, wordTo) ? { from: partial, to: wordTo } : null
  // Each correction where it is in the text; the one at the very end only when no word is half-typed there. Those
  // overlapping one already taken are dropped.
  const fixes: Fix[] = []
  for (const item of Array.isArray(parsed.fixes) ? parsed.fixes.slice(0, 5) : []) {
    const wrong = str((item as { wrong?: unknown })?.wrong, true), fixTo = str((item as { fix?: unknown })?.fix, true)
    if (!wrong || !fixTo || fixTo === wrong) continue
    const fix = narrowFix(text, wrong, fixTo) ?? (word ? null : fixAtEnd(text, wrong, fixTo))
    if (fix && !fixes.some(f => fix.start < f.end && f.start < fix.end)) fixes.push(fix)
  }
  fixes.sort((a, b) => a.start - b.start)
  return word || fixes.length ? { word, fixes } : null
}

const DESCRIBE = lang === 'pt'
  ? 'Esta imagem chegou numa conversa de WhatsApp e quem a recebeu só a vê em baixa resolução, num terminal. Descreve-a em uma ou duas frases curtas, em português de Portugal: o que mostra (pessoas, objectos, lugar, o que se passa) e, se tiver texto legível, o que diz (sem texto, não o menciones). Responde só com a descrição.'
  : "This image arrived in a WhatsApp chat and whoever got it only sees it in low resolution, in a terminal. Describe it in one or two short sentences: what it shows (people, objects, place, what is going on) and, if it has legible text, what it says (with no text, don't mention it). Answer only with the description."

/** What an image shows, in a sentence or two in the user's language, from the PNG already decoded for drawing it. */
export async function describe(png: Buffer, signal: AbortSignal): Promise<string | null> {
  const body = {
    model: MODEL,
    temperature: 0,
    max_tokens: 200,
    reasoning_effort: 'none',
    chat_template_kwargs: { enable_thinking: false },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: DESCRIBE },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
      ],
    }],
  }
  const res = await fetch(`${URL}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  if (!res.ok) { logger.warn({ status: res.status }, 'llm: describe'); return null }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  return data.choices?.[0]?.message?.content?.replace(/\s+/g, ' ').trim() || null
}

const REPLY_PT = `Ajudas-me a responder no WhatsApp. Recebes o meu nome, a hora de agora e as mensagens recentes de uma conversa, cada uma com o dia e a hora; as minhas vêm como "eu". As últimas são do outro lado e ainda não lhes respondi.
Primeiro decide se pedem resposta minha ("needed"): sim, se houver uma pergunta ou um pedido dirigido a mim, um convite, ou um cumprimento ou uma despedida; não, se forem um comentário, uma notícia, um link, uma imagem, um "ok", ou conversa entre outras pessoas.
Se pedirem, escreve a resposta ("reply"): curta, na língua, no tom e no estilo das minhas mensagens nesta conversa. Só começa por um cumprimento se me cumprimentaram, e então com o certo para a hora de agora. Não inventes factos, horas nem compromissos que a conversa não diga.
Responde só com JSON: {"needed": true|false, "reply": "..."}.`

const REPLY_EN = `You help me reply on WhatsApp. You get my name, the time now and the recent messages of a chat, each with its day and time; mine come as "me". The last ones are from the other side and I haven't answered them yet.
First decide whether they call for an answer from me ("needed"): yes, if there's a question or a request addressed to me, an invitation, or a greeting or a goodbye; no, if they're a remark, news, a link, an image, an "ok", or talk between other people.
If they do, write the answer ("reply"): short, in the language, tone and style of my messages in this chat. Only open with a greeting if they greeted me, and then with the right one for the time now. Don't make up facts, times or commitments the chat doesn't state.
Answer only with JSON: {"needed": true|false, "reply": "..."}.`

const REPLY_LABELS = lang === 'pt'
  ? { me: 'Eu sou', now: 'Agora:', chat: 'Conversa com', group: 'Grupo' }
  : { me: 'I am', now: 'Now:', chat: 'Chat with', group: 'Group' }

const REPLY_SCHEMA = {
  type: 'object',
  properties: { needed: { type: 'boolean' }, reply: { type: 'string', maxLength: 300 } },
  required: ['needed', 'reply'],
  additionalProperties: false,
}

/**
 * My answer to the other side's last messages in a chat, still unanswered, from its latest messages (`when` already
 * as day and time, `who` "eu"/"me" for mine): null when they don't call for one (a remark, a link, an "ok").
 */
export async function suggestReply(chat: { name: string; group: boolean; me: string | null }, messages: { when: string; who: string; text: string }[], signal: AbortSignal): Promise<string | null> {
  const now = new Date().toLocaleString(lang === 'pt' ? 'pt-PT' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
  const user = [
    ...(chat.me ? [`${REPLY_LABELS.me} ${chat.me}.`] : []),
    `${REPLY_LABELS.now} ${now}`,
    `${chat.group ? REPLY_LABELS.group : REPLY_LABELS.chat} ${chat.name}:`,
    ...messages.map(m => `[${m.when}] ${m.who}: ${m.text.replace(/\s+/g, ' ').slice(0, 300)}`),
  ].join('\n')
  const body = {
    model: MODEL,
    temperature: 0,
    max_tokens: 150,
    reasoning_effort: 'none',
    chat_template_kwargs: { enable_thinking: false },
    response_format: { type: 'json_schema', json_schema: { name: 'reply', schema: REPLY_SCHEMA } },
    messages: [{ role: 'system', content: lang === 'pt' ? REPLY_PT : REPLY_EN }, { role: 'user', content: user }],
  }
  const res = await fetch(`${URL}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  if (!res.ok) { logger.warn({ status: res.status }, 'llm: reply'); return null }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  let parsed: { needed?: unknown; reply?: unknown }
  try { parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '') } catch { return null }
  return parsed.needed === true && typeof parsed.reply === 'string' ? parsed.reply.trim().replace(/^["“](.*)["”]$/s, '$1') || null : null
}
