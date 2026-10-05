import { connect } from 'node:net'
import { logger } from './log.js'

/**
 * Dentro do Herdr (o multiplexador de terminais para agentes) o wa apresenta-se como um agente chamado "wa" no pane em
 * que corre, para a barra lateral mostrar o estado: a escrever alguém → working, mensagens por ler → blocked (pede
 * atenção), nada → idle. A ligação é a mesma dos hooks oficiais: uma linha JSON pelo socket Unix, sem esperar resposta.
 */
export type HerdrState = 'idle' | 'working' | 'blocked' | 'unknown'

const env = process.env
export const inHerdr = env.HERDR_ENV === '1' && !!env.HERDR_SOCKET_PATH && !!env.HERDR_PANE_ID

let lastSent = ''

function call(method: string, params: Record<string, unknown>) {
  const request = { id: `wa:${Date.now()}:${Math.floor(Math.random() * 1e6)}`, method, params: { pane_id: env.HERDR_PANE_ID, source: 'wa', agent: 'wa', seq: Date.now(), ...params } }
  const sock = connect(env.HERDR_SOCKET_PATH!)
  sock.setTimeout(500, () => sock.destroy())
  sock.on('error', e => logger.warn({ e: String(e), method }, 'herdr'))
  sock.on('data', () => sock.end())
  sock.end(JSON.stringify(request) + '\n')
}

export function reportHerdr(state: HerdrState, message?: string) {
  if (!inHerdr) return
  const key = `${state}\n${message ?? ''}`
  if (key === lastSent) return
  lastSent = key
  call('pane.report_agent', { state, message: message ?? null })
}

export function releaseHerdr() {
  if (!inHerdr) return
  call('pane.release_agent', {})
}
