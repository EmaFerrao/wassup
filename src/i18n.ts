/**
 * User-facing strings in the user's language. Only Portuguese (Portugal) and English for now, picked from WA_LANG or,
 * failing that, from the locale (LC_ALL, LC_MESSAGES, LANG): anything starting with "pt" is Portuguese, the rest English.
 * Emoji names and the writing suggestions follow the same choice.
 */
export type Lang = 'pt' | 'en'

const locale = process.env.WA_LANG ?? process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG ?? ''
export const lang: Lang = /^pt/i.test(locale) ? 'pt' : 'en'

const STRINGS = {
  help: {
    pt: 'Tab muda de tab (com texto, aceita a sugestão) · / conversas · Esc fecha · PgUp/PgDn histórico · ↑ ou clique selecciona mensagem, escrever responde, : reage · :fixe: emoji',
    en: 'Tab switches tabs (with text, accepts the suggestion) · / chats · Esc closes · PgUp/PgDn history · ↑ or click selects a message, typing replies, : reacts · :thumbsup: emoji',
  },
  connecting: { pt: 'a ligar…', en: 'connecting…' },
  waitingQr: { pt: 'à espera do QR', en: 'waiting for the QR' },
  disconnected: { pt: 'desligado', en: 'disconnected' },
  qrTitle: { pt: 'Ligar o WhatsApp', en: 'Link WhatsApp' },
  qrHint: { pt: 'No telemóvel: WhatsApp › Definições › Dispositivos associados › Associar dispositivo', en: 'On the phone: WhatsApp › Settings › Linked devices › Link a device' },
  me: { pt: 'eu', en: 'me' },
  onlyOwnText: { pt: 'só podes corrigir mensagens de texto tuas', en: 'you can only edit your own text messages' },
  onlyOwnEdit: { pt: 'só podes editar mensagens tuas', en: 'you can only edit your own messages' },
  unknownMessage: { pt: 'mensagem desconhecida', en: 'unknown message' },
  noConnection: { pt: 'sem ligação ao WhatsApp; espera pelo ● verde', en: 'no WhatsApp connection; wait for the green ●' },
  reactionRemoved: { pt: 'reacção retirada', en: 'reaction removed' },
  copied: { pt: 'copiado', en: 'copied' },
  error: { pt: 'erro', en: 'error' },
  openFirst: { pt: 'abre primeiro uma conversa ("/")', en: 'open a chat first ("/")' },
  unknownCommand: { pt: 'comando desconhecido', en: 'unknown command' },
  typing: { pt: 'a escrever…', en: 'typing…' },
  typingWho: { pt: '{0} a escrever', en: '{0} typing' },
  noChatWith: { pt: 'nenhuma conversa com "{0}"', en: 'no chat matching "{0}"' },
  deleted: { pt: 'mensagem apagada', en: 'message deleted' },
  edited: { pt: '(editada)', en: '(edited)' },
  unavailable: { pt: '(indisponível)', en: '(unavailable)' },
  mediaUnavailable: { pt: '[{0} indisponível]', en: '[{0} unavailable]' },
  mediaUnreadable: { pt: '[{0} ilegível: {1}]', en: '[{0} unreadable: {1}]' },
  attachmentExpired: { pt: 'anexo indisponível (expirou no WhatsApp)', en: 'attachment unavailable (expired on WhatsApp)' },
  downloading: { pt: 'a descarregar…', en: 'downloading…' },
  cannotOpen: { pt: 'não consegui abrir (xdg-open): {0}', en: 'could not open (xdg-open): {0}' },
  file: { pt: 'ficheiro', en: 'file' },
  voiceMessage: { pt: 'mensagem de voz', en: 'voice message' },
  audio: { pt: 'áudio', en: 'audio' },
  video: { pt: 'vídeo', en: 'video' },
  image: { pt: 'imagem', en: 'image' },
  gif: { pt: 'gif', en: 'gif' },
  sticker: { pt: 'sticker', en: 'sticker' },
  voice: { pt: 'voz', en: 'voice' },
  location: { pt: 'localização', en: 'location' },
  contact: { pt: 'contacto', en: 'contact' },
  poll: { pt: 'sondagem', en: 'poll' },
  editHeader: { pt: '✎ editar: {0} · Enter envia, Esc desiste', en: '✎ edit: {0} · Enter sends, Esc cancels' },
  reactHeader: { pt: 'reagir a {0}: {1} · :código: ou emoji e Enter', en: 'react to {0}: {1} · :code: or emoji then Enter' },
  today: { pt: 'hoje', en: 'today' },
  yesterday: { pt: 'ontem', en: 'yesterday' },
  months: { pt: 'jan fev mar abr mai jun jul ago set out nov dez', en: 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec' },
  anotherInstance: { pt: 'outra instância do wa ligou-se com esta conta; fecha-a e reinicia este', en: 'another wa instance connected with this account; close it and restart this one' },
  loggedOut: { pt: 'sessão terminada no telemóvel; novo QR a caminho', en: 'session ended on the phone; a new QR is coming' },
  closedReconnecting: { pt: 'ligação fechada ({0}), a religar', en: 'connection closed ({0}), reconnecting' },
  historyProgress: { pt: 'histórico: {0} mensagens, {1} conversas{2}', en: 'history: {0} messages, {1} chats{2}' },
  historyDone: { pt: 'histórico sincronizado', en: 'history synced' },
  notConnectedYet: { pt: 'ainda sem ligação', en: 'not connected yet' },
  serverGone: { pt: 'o processo servidor terminou; a assumir a ligação', en: 'the server process ended; taking over the connection' },
  noServer: { pt: 'não consegui ligar-me ao servidor nem ser servidor', en: 'could not connect to the server nor become one' },
  serverEnded: { pt: 'servidor terminou', en: 'server ended' },
  serverError: { pt: 'erro no servidor', en: 'server error' },
  unknownOp: { pt: 'operação desconhecida: {0}', en: 'unknown operation: {0}' },
  group: { pt: 'grupo {0}', en: 'group {0}' },
  loading: { pt: 'a carregar…', en: 'loading…' },
} as const

export type Key = keyof typeof STRINGS

/** The string for `key` in the user's language, with `{0}`, `{1}`… replaced by `args`. */
export function t(key: Key, ...args: (string | number)[]): string {
  return STRINGS[key][lang].replace(/\{(\d)\}/g, (_m, i: string) => String(args[Number(i)] ?? ''))
}
