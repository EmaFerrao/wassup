import pino from 'pino'
import { dirs } from './config.js'

// O terminal é da interface: tudo o que seria escrito no stdout (baileys, console.*) vai para o ficheiro de log.
export const logger = pino({ level: process.env.WA_LOG ?? 'warn' }, pino.destination({ dest: dirs.log, sync: true }))

/** Interacções do utilizador (rato, teclas, foco): sempre registadas, para diagnosticar terminais, seja qual for o WA_LOG. */
export const uiLog = logger.child({ mod: 'ui' }, { level: 'info' })

export function silenceConsole() {
  const fmt = (args: unknown[]) => args.map(a => (a instanceof Error ? a.stack ?? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  console.log = (...a: unknown[]) => logger.info(fmt(a))
  console.info = (...a: unknown[]) => logger.info(fmt(a))
  console.warn = (...a: unknown[]) => logger.warn(fmt(a))
  console.error = (...a: unknown[]) => logger.error(fmt(a))
  console.debug = (...a: unknown[]) => logger.debug(fmt(a))
}
