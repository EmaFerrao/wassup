import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { logger } from './log.js'

/**
 * Inside Herdr (the terminal multiplexer for agents) wassup presents itself as an agent called "wassup" in the pane it
 * runs in, so the sidebar shows its state: someone typing → working, unread messages → blocked (asks for
 * attention), nothing → idle. The agent's name follows the window title, with the name of the active conversation.
 * The connection is the same as the official hooks: one JSON line over the Unix socket.
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
      try { result = (JSON.parse(buf.slice(0, buf.indexOf('\n'))) as { result?: unknown }).result } catch { /* odd response: stays undefined */ }
      sock.end()
    })
    sock.on('close', () => resolve(result))
    sock.end(JSON.stringify(request) + '\n')
  })
}

/** Requests about the agent's pane always carry the origin and the sequence. */
function pane(method: string, params: Record<string, unknown>) {
  return call(method, { pane_id: env.HERDR_PANE_ID, source: 'wassup', agent: 'wassup', seq: ++seq, ...params })
}

export function reportHerdr(state: HerdrState, message?: string) {
  if (!inHerdr) return
  const key = `${state}\n${message ?? ''}`
  if (key === lastState) return
  lastState = key
  void pane('pane.report_agent', { state, message: message ?? null })
}

/**
 * The window's title ("● Fulano", "⠋ Fulano" while they type) goes on the agent (`display_agent`, what the sidebar
 * shows for the pane in place of "wassup"), the same whether wa is alone in its tab or in a pane of a split one. When
 * wa is alone in its tab, the tab's label also takes the chat's short name (a first name, no state, nothing for a bare
 * number); the label that was there is saved to restore it on exit. Pane labels are left alone. Requests queue up so they don't overtake each other.
 */
let titleQueue: Promise<unknown> = Promise.resolve()
let lastTab: string | null | undefined
/** The tab's original label when wa is alone in it, undefined when it isn't (so the label stays). */
let tabOriginal: Promise<string | null | undefined> | undefined

export function titleHerdr(title: string) {
  if (!inHerdr || title === lastTitle) return
  lastTitle = title
  // While the typing spinner turns a title comes every 80 ms: one overtaken by a later one in the queue isn't sent.
  titleQueue = titleQueue.then(() => { if (title === lastTitle) return pane('pane.report_metadata', { display_agent: title }) })
}

export function tabNameHerdr(name: string | null) {
  if (!inHerdr || name === lastTab) return
  lastTab = name
  tabOriginal ??= call('tab.get', { tab_id: env.HERDR_TAB_ID })
    .then(r => { const tab = (r as { tab?: { pane_count?: number; label?: string | null } } | undefined)?.tab; return tab && (tab.pane_count ?? 1) <= 1 ? tab.label ?? null : undefined })
  titleQueue = titleQueue.then(async () => {
    const original = await tabOriginal
    if (original !== undefined) await call('tab.rename', { tab_id: env.HERDR_TAB_ID, label: name ?? original ?? '' })
  })
}

/** The `wa` launcher at the project root, to open another conversation in another Herdr tab. */
const waBin = fileURLToPath(new URL('../wa', import.meta.url))

/**
 * Opens the conversation in a new Herdr pane or tab (focused when it was chosen, unfocused when it's an incoming
 * message). `how` says which; left open, it follows the layout: when wa's tab is already split, a new pane, when wa
 * is alone in its tab, a new tab. A pane goes beside this one, to the right if the pane is wide enough for two
 * conversations (100 columns), below otherwise. The new shell receives `exec wa <jid>`, so when the conversation
 * closes the pane or tab closes with it.
 */
export async function openChatHerdr(jid: string, focus = true, how?: 'pane' | 'tab') {
  if (!inHerdr) return
  if (!how) {
    const tab = (await call('tab.get', { tab_id: env.HERDR_TAB_ID }) as { tab?: { pane_count?: number } } | undefined)?.tab
    how = (tab?.pane_count ?? 1) > 1 ? 'pane' : 'tab'
  }
  let paneId: string | undefined
  if (how === 'pane') {
    const layout = (await call('pane.layout', { pane_id: env.HERDR_PANE_ID }) as { layout?: { panes?: { pane_id: string; rect: { width: number } }[] } } | undefined)?.layout
    const width = layout?.panes?.find(p => p.pane_id === env.HERDR_PANE_ID)?.rect.width ?? 0
    const created = await call('pane.split', { pane_id: env.HERDR_PANE_ID, direction: width >= 100 ? 'right' : 'down', focus, cwd: process.cwd() }) as { pane?: { pane_id?: string } } | undefined
    paneId = created?.pane?.pane_id
    if (!paneId) return logger.warn({ jid }, 'herdr: pane.split without pane')
  } else {
    const created = await call('tab.create', { workspace_id: env.HERDR_WORKSPACE_ID ?? null, cwd: process.cwd(), focus }) as { root_pane?: { pane_id?: string } } | undefined
    paneId = created?.root_pane?.pane_id
    if (!paneId) return logger.warn({ jid }, 'herdr: tab.create without pane')
  }
  await call('pane.send_input', { pane_id: paneId, text: `exec '${waBin}' '${jid}'`, keys: ['enter'] })
}

/** Whether this pane has the focus in Herdr, which the terminal's focus events only say once it changes. */
export async function paneFocusedHerdr(): Promise<boolean | undefined> {
  if (!inHerdr) return undefined
  const pane = (await call('pane.get', { pane_id: env.HERDR_PANE_ID }) as { pane?: { focused?: boolean } } | undefined)?.pane
  return pane?.focused
}

/**
 * Moves the focus to the next pane running wassup in this workspace, in the order Herdr shows them (tabs by number,
 * then the panes of each tab in its own order), from the last back to the first. Panes are told apart by the agent
 * wassup reports in them. Resolves false when there's no other.
 */
export async function focusNextChatHerdr(): Promise<boolean> {
  if (!inHerdr) return false
  const ws = env.HERDR_WORKSPACE_ID ?? null
  const tabs = (await call('tab.list', { workspace_id: ws }) as { tabs?: { tab_id: string; number: number }[] } | undefined)?.tabs ?? []
  const panes = (await call('pane.list', { workspace_id: ws }) as { panes?: { pane_id: string; tab_id: string; agent?: string }[] } | undefined)?.panes ?? []
  const order = new Map(tabs.map(t => [t.tab_id, t.number]))
  const ring = panes.map((p, i) => ({ ...p, i })).filter(p => p.agent === 'wassup')
    .sort((a, b) => (order.get(a.tab_id) ?? 0) - (order.get(b.tab_id) ?? 0) || a.i - b.i)
  const at = ring.findIndex(p => p.pane_id === env.HERDR_PANE_ID)
  if (ring.length < 2 || at < 0) return false
  const next = ring[(at + 1) % ring.length]!
  await call('tab.focus', { tab_id: next.tab_id })
  await call('pane.focus', { pane_id: next.pane_id })
  return true
}

/** Switches to the Herdr tab, and the pane in it, where the conversation is already open. */
export function focusHerdr(tabId: string, paneId?: string) {
  if (!inHerdr) return
  void call('tab.focus', { tab_id: tabId }).then(() => { if (paneId) return call('pane.focus', { pane_id: paneId }) })
}

/**
 * On exit, removes itself from the list, clears its name and restores the tab's label; resolves once the requests
 * are sent, so the process doesn't end before that.
 */
export async function releaseHerdr(): Promise<void> {
  if (!inHerdr) return
  if (lastTab) tabNameHerdr(null)
  const clear = titleQueue.then(() => { if (lastTitle) return pane('pane.report_metadata', { clear_display_agent: true }) })
  await Promise.all([pane('pane.release_agent', {}), clear])
}
