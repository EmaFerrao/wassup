import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Everything the client stores lives in ~/.config/yap (or YAP_HOME): credentials, database, attachments and log.
const base = process.env.YAP_HOME ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'yap')

export const dirs = {
  base,
  auth: path.join(base, 'auth'),
  media: path.join(base, 'media'),
  db: path.join(base, 'yap.db'),
  log: path.join(base, 'yap.log'),
  downloads: path.join(os.homedir(), 'Downloads', 'yap'),
}

for (const d of [dirs.base, dirs.auth, dirs.media]) fs.mkdirSync(d, { recursive: true })
