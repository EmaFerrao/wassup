import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Everything the client stores lives in ~/.config/wa (or WA_HOME): credentials, database, attachments and log.
const base = process.env.WA_HOME ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'wa')

export const dirs = {
  base,
  auth: path.join(base, 'auth'),
  media: path.join(base, 'media'),
  db: path.join(base, 'wa.db'),
  log: path.join(base, 'wa.log'),
  downloads: path.join(os.homedir(), 'Downloads', 'wa'),
}

// Private to this user: credentials, messages and attachments are nobody else's business on a shared machine.
// The umask covers everything the process creates from here on (SQLite's files, the log, each chat's media folder,
// downloaded attachments); the chmod repairs folders made before this, or by hand.
process.umask(0o077)
for (const d of [dirs.base, dirs.auth, dirs.media]) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); fs.chmodSync(d, 0o700) }
