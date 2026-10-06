import pino from 'pino'
import { dirs } from './config.js'

// The terminal belongs to the UI: everything that would be written to stdout (baileys, console.*) goes to the log file.
export const logger = pino({ level: process.env.YAP_LOG ?? 'warn' }, pino.destination({ dest: dirs.log, sync: true }))

/** User interactions (mouse, keys, focus): always logged, to diagnose terminals, whatever YAP_LOG is. */
export const uiLog = logger.child({ mod: 'ui' }, { level: 'info' })

export function silenceConsole() {
  const fmt = (args: unknown[]) => args.map(a => (a instanceof Error ? a.stack ?? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  console.log = (...a: unknown[]) => logger.info(fmt(a))
  console.info = (...a: unknown[]) => logger.info(fmt(a))
  console.warn = (...a: unknown[]) => logger.warn(fmt(a))
  console.error = (...a: unknown[]) => logger.error(fmt(a))
  console.debug = (...a: unknown[]) => logger.debug(fmt(a))
}
