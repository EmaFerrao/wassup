import { silenceConsole, logger } from './log.js'
import { Wa } from './wa.js'
import { Ui } from './ui.js'
import { probeTerminal } from './term.js'
import { acquireLock } from './lock.js'

let ui: Ui | undefined
const other = await acquireLock(() => (ui ? ui.quit('wa: substituído por outra instância') : process.exit(0)))
if (other) {
  process.stderr.write(`wa: a instância anterior (pid ${other}) não terminou; fecha-a primeiro.\n`)
  process.exit(1)
}
silenceConsole()
process.on('uncaughtException', e => logger.error({ e: e.stack ?? String(e) }, 'uncaughtException'))
process.on('unhandledRejection', e => logger.error({ e: e instanceof Error ? e.stack : String(e) }, 'unhandledRejection'))

const caps = await probeTerminal()
const wa = new Wa()
ui = new Ui(wa, caps)
wa.start().catch(e => logger.error({ e }, 'start'))
