import type { EventEmitter } from 'node:events'
import type { MessageRow } from './db.js'
import type { ConnState, WaEvents } from './wa.js'

/**
 * What the UI needs from whoever talks to WhatsApp. `Wa` (our own connection, in the server process) and
 * `RemoteWa` (another process's client, over the socket) implement it; the UI doesn't know which one it has.
 */
export interface Backend extends EventEmitter<WaEvents> {
  readonly me: string
  readonly state: ConnState
  readonly qr: string | undefined
  send(chatJid: string, text: string, replyTo?: string): Promise<void>
  react(chatJid: string, msgId: string, emoji: string): Promise<void>
  edit(chatJid: string, msgId: string, text: string): Promise<void>
  sendFile(chatJid: string, filePath: string, caption?: string): Promise<void>
  markRead(chatJid: string): Promise<void>
  subscribePresence(chatJid: string): void
  setComposing(chatJid: string, on: boolean): void
  touchPresence(): void
  ensureMedia(row: MessageRow): void
  downloadAll(chatJid: string): Promise<{ copied: number; pending: number }>
  stop(): Promise<void>
}
