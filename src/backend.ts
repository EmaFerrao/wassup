import type { EventEmitter } from 'node:events'
import type { MessageRow } from './db.js'
import type { ConnState, WaEvents } from './wa.js'

/**
 * O que a interface precisa de quem fala com o WhatsApp. O `Wa` (ligação própria, no processo servidor) e o `RemoteWa`
 * (cliente de outro processo, pelo socket) implementam-no; a interface não sabe qual tem à frente.
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
  touchPresence(): void
  ensureMedia(row: MessageRow): void
  downloadAll(chatJid: string): Promise<{ copied: number; pending: number }>
  stop(): Promise<void>
}
