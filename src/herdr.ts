import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { logger } from './log.js'

/**
 * Inside Herdr (the terminal multiplexer for agents) yap presents itself as an agent called "yap" in the pane it
 * runs in, so the sidebar shows its state: someone typing → working, unread messages → blocked (asks for
 * attention), nothing → idle. The tab's title (or the pane's, if the tab is split) follows the window title, with
 * the name of the active conversation. The connection is the same as the official hooks: one JSON line over the Unix socket.
 */
export type HerdrState = 'idle' | 'working' | 'blocked' | 'unknown'

const env = process.env
export const inHerdr = env.HERDR_ENV === '1' && !!env.HERDR_SOCKET_PATH && !!env.HERDR_PANE_ID && !!env.HERDR_TAB_ID

// Herdr orders requests from the same origin by seq; two in the same millisecond can't tie.
let seq = Date.now()
let lastState = ''
let lastTitle = ''

/** A request; returns the response's `result`, or undefined if it fails or doesn't respond within half a second. */
function call(method: string, params: Record<string, unknown>): Promise<unknown> {
  const request = { id: `yap:${Date.now()}:${Math.floor(Math.random() * 1e6)}`, method, params }
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
      try { result = (JSON.parse(buf.slice(0, buf.indexOf('\n'))) as { result?: unknown }).result } catch { /* odd response: stays undefined */ }
      sock.end()
    })
    sock.on('close', () => resolve(result))
    sock.end(JSON.stringify(request) + '\n')
  })
}

/** Requests about the agent's pane always carry the origin and the sequence. */
function pane(method: string, params: Record<string, unknown>) {
  return call(method, { pane_id: env.HERDR_PANE_ID, source: 'yap', agent: 'yap', seq: ++seq, ...params })
}

export function reportHerdr(state: HerdrState, message?: string) {
  if (!inHerdr) return
  const key = `${state}\n${message ?? ''}`
  if (key === lastState) return
  lastState = key
  void pane('pane.report_agent', { state, message: message ?? null })
}

/**
 * The tab's title follows the window's ("● Fulano") if yap is the tab's only pane; in a split tab it's the pane that
 * carries it. The name that was there is saved to restore it on exit. Requests queue up so they don't overtake each other.
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

/** The `yap` launcher at the project root, to open another conversation in another Herdr tab. */
const waBin = fileURLToPath(new URL('../yap', import.meta.url))

/**
 * Opens the conversation in a new Herdr tab (focused when it was chosen, unfocused when it's an incoming message):
 * the tab's shell receives `exec yap <jid>`, so when the conversation closes the tab closes with it.
 */
export async function openChatHerdr(jid: string, name: string, focus = true) {
  if (!inHerdr) return
  const created = await call('tab.create', { workspace_id: env.HERDR_WORKSPACE_ID ?? null, cwd: process.cwd(), focus, label: name }) as { root_pane?: { pane_id?: string } } | undefined
  const paneId = created?.root_pane?.pane_id
  if (!paneId) return logger.warn({ jid }, 'herdr: tab.create without pane')
  await call('pane.send_input', { pane_id: paneId, text: `exec '${waBin}' '${jid}'`, keys: ['enter'] })
}

/** Switches to the Herdr tab where the conversation is already open. */
export function focusTabHerdr(tabId: string) {
  if (!inHerdr) return
  void call('tab.focus', { tab_id: tabId })
}

/** On exit, removes itself from the list and restores the title; resolves once the requests are sent, so the process doesn't end before that. */
export async function releaseHerdr(): Promise<void> {
  if (!inHerdr) return
  const restore = titleQueue.then(async () => { const t = await target; if (t && lastTitle) await rename(t, null) })
  await Promise.all([pane('pane.release_agent', {}), restore])
}
