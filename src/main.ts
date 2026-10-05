import { EventEmitter } from 'node:events'
import { silenceConsole, logger } from './log.js'
import { Wa, type WaEvents } from './wa.js'
import { Ui } from './ui.js'
import { probeTerminal } from './term.js'
import { IpcServer, RemoteWa } from './ipc.js'
import type { Backend } from './backend.js'
import type { MessageRow } from './db.js'

silenceConsole()
process.on('uncaughtException', e => logger.error({ e: e.stack ?? String(e) }, 'uncaughtException'))
process.on('unhandledRejection', e => logger.error({ e: e instanceof Error ? e.stack : String(e) }, 'unhandledRejection'))

/**
 * A interface fala sempre com este proxy; por trás está ou a ligação própria (este processo é o servidor) ou o cliente
 * de outro processo. Quando o servidor desaparece, repete-se a eleição e troca-se o que está por trás sem a interface dar conta.
 */
class BackendProxy extends EventEmitter<WaEvents> implements Backend {
  private inner: Backend | undefined
  private server: IpcServer | undefined
  get me() { return this.inner?.me ?? '' }
  get state() { return this.inner?.state ?? 'connecting' }
  get qr() { return this.inner?.qr }
  // Antes da eleição acabar não há backend: as acções que não são possíveis falham com mensagem, as outras ignoram-se.
  private ready(): Backend { if (!this.inner) throw new Error('ainda sem ligação'); return this.inner }
  send(jid: string, text: string, replyTo?: string) { return this.ready().send(jid, text, replyTo) }
  react(jid: string, msgId: string, emoji: string) { return this.ready().react(jid, msgId, emoji) }
  edit(jid: string, msgId: string, text: string) { return this.ready().edit(jid, msgId, text) }
  sendFile(jid: string, file: string, caption?: string) { return this.ready().sendFile(jid, file, caption) }
  async markRead(jid: string) { await this.inner?.markRead(jid) }
  subscribePresence(jid: string) { this.inner?.subscribePresence(jid) }
  touchPresence() { this.inner?.touchPresence() }
  ensureMedia(row: MessageRow) { this.inner?.ensureMedia(row) }
  downloadAll(jid: string) { return this.ready().downloadAll(jid) }
  async stop() { this.server?.close(); await this.inner?.stop() }

  /** Liga-se ao servidor que houver; se não houver, este processo passa a servidor. */
  async elect() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const remote = await RemoteWa.connect()
      if (remote) {
        this.use(remote)
        remote.once('lost', () => {
          logger.warn('ipc: servidor perdido, nova eleição')
          this.emit('status', 'o processo servidor terminou; a assumir a ligação')
          this.elect().catch(e => logger.error({ e }, 'elect'))
        })
        return
      }
      const wa = new Wa()
      const server = new IpcServer(wa)
      try {
        await server.listen()
      } catch (e) {
        // Outro processo abriu o socket neste instante: volta a tentar como cliente. Qualquer outro erro é definitivo.
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e
        logger.info('ipc: socket ocupado, a tentar como cliente')
        continue
      }
      this.server = server
      this.use(wa)
      wa.start().catch(e => logger.error({ e }, 'start'))
      return
    }
    throw new Error('não consegui ligar-me ao servidor nem ser servidor')
  }

  private use(b: Backend) {
    this.inner = b
    for (const ev of ['connection', 'chats', 'messages', 'notify', 'status', 'typing'] as const) {
      b.on(ev, ((...args: unknown[]) => (this.emit as (ev: string, ...a: unknown[]) => boolean)(ev, ...args)) as never)
    }
    this.emit('connection', b.state)
  }
}

const caps = await probeTerminal()
const backend = new BackendProxy()
new Ui(backend, caps)
await backend.elect()
