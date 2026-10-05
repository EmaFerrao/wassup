import { connect } from 'node:net'
import { logger } from './log.js'

/**
 * Dentro do Herdr (o multiplexador de terminais para agentes) o wa apresenta-se como um agente chamado "wa" no pane em
 * que corre, para a barra lateral mostrar o estado: a escrever alguém → working, mensagens por ler → blocked (pede
 * atenção), nada → idle. O título do tab (ou do pane, se o tab estiver dividido) acompanha o título da janela, com o
 * nome da conversa activa. A ligação é a mesma dos hooks oficiais: uma linha JSON pelo socket Unix.
 */
export type HerdrState = 'idle' | 'working' | 'blocked' | 'unknown'

const env = process.env
export const inHerdr = env.HERDR_ENV === '1' && !!env.HERDR_SOCKET_PATH && !!env.HERDR_PANE_ID && !!env.HERDR_TAB_ID

// O Herdr ordena os pedidos da mesma origem por seq; dois no mesmo milissegundo não podem empatar.
let seq = Date.now()
let lastState = ''
let lastTitle = ''

/** Um pedido; devolve o `result` da resposta, ou undefined se falhar ou não responder em meio segundo. */
function call(method: string, params: Record<string, unknown>): Promise<unknown> {
  const request = { id: `wa:${Date.now()}:${Math.floor(Math.random() * 1e6)}`, method, params }
  logger.info({ method, params }, 'herdr')
  return new Promise(resolve => {
    let buf = ''
    let result: unknown
    const sock = connect(env.HERDR_SOCKET_PATH!)
    sock.setTimeout(500, () => sock.destroy())
    sock.on('error', e => logger.warn({ e: String(e), method }, 'herdr'))
    sock.on('data', d => {
      buf += d.toString()
      if (!buf.includes('\n')) return
      try { result = (JSON.parse(buf.slice(0, buf.indexOf('\n'))) as { result?: unknown }).result } catch { /* resposta estranha: fica undefined */ }
      sock.end()
    })
    sock.on('close', () => resolve(result))
    sock.end(JSON.stringify(request) + '\n')
  })
}

/** Pedidos sobre o pane do agente levam sempre a origem e a sequência. */
function pane(method: string, params: Record<string, unknown>) {
  return call(method, { pane_id: env.HERDR_PANE_ID, source: 'wa', agent: 'wa', seq: ++seq, ...params })
}

export function reportHerdr(state: HerdrState, message?: string) {
  if (!inHerdr) return
  const key = `${state}\n${message ?? ''}`
  if (key === lastState) return
  lastState = key
  void pane('pane.report_agent', { state, message: message ?? null })
}

/**
 * O título do tab segue o da janela ("● Fulano") se o wa for o único pane do tab; num tab dividido é o pane que o leva.
 * Guarda-se o nome que lá estava para o repor à saída. Os pedidos seguem em fila para não se ultrapassarem.
 */
type Target = { kind: 'tab' | 'pane'; original: string | null }
let target: Promise<Target | undefined> | undefined
let titleQueue: Promise<unknown> = Promise.resolve()

async function findTarget(): Promise<Target | undefined> {
  const tab = (await call('tab.get', { tab_id: env.HERDR_TAB_ID }) as { tab?: { pane_count?: number; label?: string | null } } | undefined)?.tab
  if (!tab) return undefined
  if ((tab.pane_count ?? 1) <= 1) return { kind: 'tab', original: tab.label ?? null }
  const p = (await call('pane.get', { pane_id: env.HERDR_PANE_ID }) as { pane?: { label?: string | null } } | undefined)?.pane
  return { kind: 'pane', original: p?.label ?? null }
}

function rename(t: Target, name: string | null) {
  return t.kind === 'tab'
    ? call('tab.rename', { tab_id: env.HERDR_TAB_ID, label: name ?? t.original ?? '' })
    : call('pane.rename', { pane_id: env.HERDR_PANE_ID, label: name ?? t.original })
}

export function titleHerdr(title: string) {
  if (!inHerdr || title === lastTitle) return
  lastTitle = title
  target ??= findTarget()
  titleQueue = titleQueue.then(async () => { const t = await target; if (t) await rename(t, title) })
}

/** Ao sair tira-se da lista e repõe-se o título; devolve quando os pedidos saíram, para o processo não terminar antes. */
export async function releaseHerdr(): Promise<void> {
  if (!inHerdr) return
  const restore = titleQueue.then(async () => { const t = await target; if (t && lastTitle) await rename(t, null) })
  await Promise.all([pane('pane.release_agent', {}), restore])
}
