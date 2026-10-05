import { DatabaseSync } from 'node:sqlite'
import { dirs } from './config.js'

export interface ChatRow {
  jid: string
  name: string | null
  is_group: number
  last_ts: number
  unread: number
  archived: number
}

export interface ContactRow {
  jid: string
  name: string | null
  notify: string | null
}

export interface ReactionRow {
  chat_jid: string
  msg_id: string
  sender_jid: string
  emoji: string
}

export interface MessageRow {
  id: string
  chat_jid: string
  sender_jid: string
  from_me: number
  ts: number
  type: string
  text: string
  push_name: string | null
  quoted: string | null
  media_path: string | null
  media_mime: string | null
  media_name: string | null
  media_w: number | null
  media_h: number | null
  media_err: number
  status: number | null
  raw: string
}

// timeout: vários processos partilham a base (servidor escreve, clientes lêem e guardam os seus tabs); em vez de SQLITE_BUSY espera-se.
const db = new DatabaseSync(dirs.db, { timeout: 3000 })
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS chats (
    jid TEXT PRIMARY KEY,
    name TEXT,
    is_group INTEGER NOT NULL DEFAULT 0,
    last_ts INTEGER NOT NULL DEFAULT 0,
    unread INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS contacts (
    jid TEXT PRIMARY KEY,
    name TEXT,
    notify TEXT
  );
  CREATE TABLE IF NOT EXISTS lids (
    lid TEXT PRIMARY KEY,
    pn TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT NOT NULL,
    chat_jid TEXT NOT NULL,
    sender_jid TEXT NOT NULL,
    from_me INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    push_name TEXT,
    quoted TEXT,
    media_path TEXT,
    media_mime TEXT,
    media_name TEXT,
    media_w INTEGER,
    media_h INTEGER,
    media_err INTEGER NOT NULL DEFAULT 0,
    status INTEGER,
    raw TEXT NOT NULL,
    PRIMARY KEY (chat_jid, id)
  );
  CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages (chat_jid, ts);
  CREATE TABLE IF NOT EXISTS reactions (
    chat_jid TEXT NOT NULL,
    msg_id TEXT NOT NULL,
    sender_jid TEXT NOT NULL,
    emoji TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (chat_jid, msg_id, sender_jid)
  );
  CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`)

const q = {
  upsertChat: db.prepare(`
    INSERT INTO chats (jid, name, is_group, last_ts, unread, archived) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET
      name = COALESCE(excluded.name, chats.name),
      is_group = excluded.is_group,
      last_ts = MAX(chats.last_ts, excluded.last_ts),
      unread = excluded.unread,
      archived = excluded.archived`),
  touchChat: db.prepare(`
    INSERT INTO chats (jid, is_group, last_ts) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET last_ts = MAX(chats.last_ts, excluded.last_ts)`),
  setChatName: db.prepare(`UPDATE chats SET name = ? WHERE jid = ?`),
  bumpUnread: db.prepare(`UPDATE chats SET unread = unread + 1 WHERE jid = ?`),
  clearUnread: db.prepare(`UPDATE chats SET unread = 0 WHERE jid = ?`),
  listChats: db.prepare(`SELECT * FROM chats WHERE last_ts > 0 ORDER BY last_ts DESC`),
  getChat: db.prepare(`SELECT * FROM chats WHERE jid = ?`),
  upsertContact: db.prepare(`
    INSERT INTO contacts (jid, name, notify) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET
      name = COALESCE(excluded.name, contacts.name),
      notify = COALESCE(excluded.notify, contacts.notify)`),
  getContact: db.prepare(`SELECT * FROM contacts WHERE jid = ?`),
  setLid: db.prepare(`INSERT OR REPLACE INTO lids (lid, pn) VALUES (?, ?)`),
  getPn: db.prepare(`SELECT pn FROM lids WHERE lid = ?`),
  upsertMessage: db.prepare(`
    INSERT INTO messages (id, chat_jid, sender_jid, from_me, ts, type, text, push_name, quoted,
      media_path, media_mime, media_name, media_w, media_h, status, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_jid, id) DO UPDATE SET
      type = excluded.type,
      text = excluded.text,
      push_name = COALESCE(excluded.push_name, messages.push_name),
      quoted = COALESCE(excluded.quoted, messages.quoted),
      media_path = COALESCE(messages.media_path, excluded.media_path),
      media_mime = COALESCE(excluded.media_mime, messages.media_mime),
      media_name = COALESCE(excluded.media_name, messages.media_name),
      media_w = COALESCE(excluded.media_w, messages.media_w),
      media_h = COALESCE(excluded.media_h, messages.media_h),
      status = COALESCE(excluded.status, messages.status),
      raw = excluded.raw`),
  hasMessage: db.prepare(`SELECT 1 FROM messages WHERE chat_jid = ? AND id = ?`),
  getMessage: db.prepare(`SELECT * FROM messages WHERE chat_jid = ? AND id = ?`),
  findMessage: db.prepare(`SELECT * FROM messages WHERE id = ? LIMIT 1`),
  listMessages: db.prepare(`SELECT * FROM (SELECT * FROM messages WHERE chat_jid = ? ORDER BY ts DESC LIMIT ?) ORDER BY ts ASC`),
  listMedia: db.prepare(`SELECT * FROM messages WHERE chat_jid = ? AND media_mime IS NOT NULL ORDER BY ts ASC`),
  unreadIncoming: db.prepare(`SELECT * FROM messages WHERE chat_jid = ? AND from_me = 0 ORDER BY ts DESC LIMIT ?`),
  setMedia: db.prepare(`UPDATE messages SET media_path = ?, media_w = ?, media_h = ?, media_err = 0 WHERE chat_jid = ? AND id = ?`),
  setMediaErr: db.prepare(`UPDATE messages SET media_err = 1 WHERE chat_jid = ? AND id = ?`),
  setStatus: db.prepare(`UPDATE messages SET status = ? WHERE chat_jid = ? AND id = ?`),
  setType: db.prepare(`UPDATE messages SET type = ?, text = ? WHERE chat_jid = ? AND id = ?`),
  lastMessage: db.prepare(`SELECT * FROM messages WHERE chat_jid = ? ORDER BY ts DESC LIMIT 1`),
  setReaction: db.prepare(`
    INSERT INTO reactions (chat_jid, msg_id, sender_jid, emoji, ts) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chat_jid, msg_id, sender_jid) DO UPDATE SET emoji = excluded.emoji, ts = excluded.ts WHERE excluded.ts >= reactions.ts`),
  clearReaction: db.prepare(`DELETE FROM reactions WHERE chat_jid = ? AND msg_id = ? AND sender_jid = ? AND ts <= ?`),
  listReactions: db.prepare(`SELECT chat_jid, msg_id, sender_jid, emoji FROM reactions WHERE chat_jid = ? ORDER BY ts ASC`),
  lidContactsUnmapped: db.prepare(`SELECT * FROM contacts k WHERE k.jid LIKE '%@lid' AND (k.name IS NOT NULL OR k.notify IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM lids l WHERE l.lid = k.jid)`),
  getState: db.prepare(`SELECT value FROM state WHERE key = ?`),
  listState: db.prepare(`SELECT key, value FROM state WHERE key LIKE ? ESCAPE '\\'`),
  setState: db.prepare(`INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)`),
  deleteState: db.prepare(`DELETE FROM state WHERE key = ?`),
}

export const store = {
  transaction<T>(fn: () => T): T {
    db.exec('BEGIN')
    try {
      const r = fn()
      db.exec('COMMIT')
      return r
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  },

  upsertChat(c: { jid: string; name?: string | null; isGroup: boolean; lastTs: number; unread: number; archived: boolean }) {
    q.upsertChat.run(c.jid, c.name ?? null, c.isGroup ? 1 : 0, c.lastTs, c.unread, c.archived ? 1 : 0)
  },
  touchChat(jid: string, isGroup: boolean, ts: number) {
    q.touchChat.run(jid, isGroup ? 1 : 0, ts)
  },
  setChatName(jid: string, name: string) {
    q.setChatName.run(name, jid)
  },
  bumpUnread(jid: string) {
    q.bumpUnread.run(jid)
  },
  clearUnread(jid: string) {
    q.clearUnread.run(jid)
  },
  listChats(): ChatRow[] {
    return q.listChats.all() as unknown as ChatRow[]
  },
  getChat(jid: string): ChatRow | undefined {
    return q.getChat.get(jid) as unknown as ChatRow | undefined
  },

  upsertContact(jid: string, name?: string | null, notify?: string | null) {
    q.upsertContact.run(jid, name ?? null, notify ?? null)
  },
  getContact(jid: string): ContactRow | undefined {
    return q.getContact.get(jid) as unknown as ContactRow | undefined
  },

  setLid(lid: string, pn: string) {
    q.setLid.run(lid, pn)
  },
  getPn(lid: string): string | undefined {
    return (q.getPn.get(lid) as { pn: string } | undefined)?.pn
  },

  upsertMessage(m: Omit<MessageRow, 'media_err'>) {
    q.upsertMessage.run(m.id, m.chat_jid, m.sender_jid, m.from_me, m.ts, m.type, m.text, m.push_name, m.quoted,
      m.media_path, m.media_mime, m.media_name, m.media_w, m.media_h, m.status, m.raw)
  },
  hasMessage(chat: string, id: string): boolean {
    return q.hasMessage.get(chat, id) != null
  },
  getMessage(chat: string, id: string): MessageRow | undefined {
    return q.getMessage.get(chat, id) as unknown as MessageRow | undefined
  },
  findMessage(id: string): MessageRow | undefined {
    return q.findMessage.get(id) as unknown as MessageRow | undefined
  },
  listMessages(chat: string, limit = 300): MessageRow[] {
    return q.listMessages.all(chat, limit) as unknown as MessageRow[]
  },
  listMedia(chat: string): MessageRow[] {
    return q.listMedia.all(chat) as unknown as MessageRow[]
  },
  unreadIncoming(chat: string, limit: number): MessageRow[] {
    return q.unreadIncoming.all(chat, limit) as unknown as MessageRow[]
  },
  setMedia(chat: string, id: string, path: string, w: number | null, h: number | null) {
    q.setMedia.run(path, w, h, chat, id)
  },
  setMediaErr(chat: string, id: string) {
    q.setMediaErr.run(chat, id)
  },
  setStatus(chat: string, id: string, status: number) {
    q.setStatus.run(status, chat, id)
  },
  setType(chat: string, id: string, type: string, text: string) {
    q.setType.run(type, text, chat, id)
  },

  /** Contactos com nome guardados pelo lid, sem número conhecido: candidatos a resolver junto do WhatsApp. */
  lidContactsUnmapped(): ContactRow[] {
    return q.lidContactsUnmapped.all() as unknown as ContactRow[]
  },
  lastMessage(chat: string): MessageRow | undefined {
    return q.lastMessage.get(chat) as unknown as MessageRow | undefined
  },

  /** Reacção de alguém a uma mensagem; emoji vazio retira-a. A mais recente ganha, venha por que ordem vier. */
  setReaction(chat: string, msgId: string, sender: string, emoji: string, ts: number) {
    if (emoji) q.setReaction.run(chat, msgId, sender, emoji, ts)
    else q.clearReaction.run(chat, msgId, sender, ts)
  },
  listReactions(chat: string): ReactionRow[] {
    return q.listReactions.all(chat) as unknown as ReactionRow[]
  },

  /** Estado da interface (tabs abertos, etc.), em JSON por chave. */
  getState<T>(key: string): T | undefined {
    const row = q.getState.get(key) as { value: string } | undefined
    if (!row) return undefined
    try { return JSON.parse(row.value) as T } catch { return undefined }
  },
  deleteState(key: string) {
    q.deleteState.run(key)
  },
  setState(key: string, value: unknown) {
    q.setState.run(key, JSON.stringify(value))
  },
  /** Todos os registos cuja chave começa por `prefix`. */
  listState<T>(prefix: string): { key: string; value: T }[] {
    const rows = q.listState.all(prefix.replace(/[%_\\]/g, '\\$&') + '%') as unknown as { key: string; value: string }[]
    const out: { key: string; value: T }[] = []
    for (const r of rows) { try { out.push({ key: r.key, value: JSON.parse(r.value) as T }) } catch { /* ignora */ } }
    return out
  },

  close() {
    db.close()
  },
}
