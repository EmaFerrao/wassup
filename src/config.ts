import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Tudo o que o cliente guarda vive em ~/.config/wa (ou WA_HOME): credenciais, base de dados, anexos e log.
const base = process.env.WA_HOME ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'wa')

export const dirs = {
  base,
  auth: path.join(base, 'auth'),
  media: path.join(base, 'media'),
  db: path.join(base, 'wa.db'),
  log: path.join(base, 'wa.log'),
  downloads: path.join(os.homedir(), 'Downloads', 'wa'),
}

for (const d of [dirs.base, dirs.auth, dirs.media]) fs.mkdirSync(d, { recursive: true })
