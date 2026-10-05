import { connect } from 'node:net'
import { logger } from './log.js'

/**
 * Dentro do Herdr (o multiplexador de terminais para agentes) o wa apresenta-se como um agente chamado "wa" no pane em
 * que corre, para a barra lateral mostrar o estado: a escrever alguém → working, mensagens por ler → blocked (pede
 * atenção), nada → idle. O rótulo leva o nome da conversa activa. A ligação é a mesma dos hooks oficiais: uma linha
 * JSON pelo socket Unix, sem esperar resposta.
 */
export type HerdrState = 'idle' | 'working' | 'blocked' | 'unknown'

const env = process.env
export const inHerdr = env.HERDR_ENV === '1' && !!env.HERDR_SOCKET_PATH && !!env.HERDR_PANE_ID

// O Herdr ordena os pedidos da mesma origem por seq; dois no mesmo milissegundo não podem empatar.
let seq = Date.now()
let lastState = ''
let lastLabel = ''

function call(method: string, params: Record<string, unknown>): Promise<void> {
  const request = { id: `wa:${Date.now()}:${Math.floor(Math.random() * 1e6)}`, method, params: { pane_id: env.HERDR_PANE_ID, source: 'wa', agent: 'wa', seq: ++seq, ...params } }
  logger.info({ method, params: request.params }, 'herdr')
  return new Promise(resolve => {
    const sock = connect(env.HERDR_SOCKET_PATH!)
    sock.setTimeout(500, () => sock.destroy())
    sock.on('error', e => logger.warn({ e: String(e), method }, 'herdr'))
    sock.on('data', () => sock.end())
    sock.on('close', () => resolve())
    sock.end(JSON.stringify(request) + '\n')
  })
}

export function reportHerdr(state: HerdrState, message?: string) {
  if (!inHerdr) return
  const key = `${state}\n${message ?? ''}`
  if (key === lastState) return
  lastState = key
  void call('pane.report_agent', { state, message: message ?? null })
}

/** O nome que aparece na lista de agentes: "wa · Fulano" com a conversa activa, ou só "wa". */
export function labelHerdr(chat: string | null) {
  if (!inHerdr) return
  const label = chat ? `wa · ${chat}` : 'wa'
  if (label === lastLabel) return
  lastLabel = label
  void call('pane.report_metadata', { display_agent: label })
}

/** Ao sair tira-se da lista; devolve quando o pedido saiu, para o processo não terminar antes. */
export function releaseHerdr(): Promise<void> {
  if (!inHerdr) return Promise.resolve()
  return call('pane.release_agent', {})
}
