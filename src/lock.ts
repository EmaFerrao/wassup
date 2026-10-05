import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dirs } from './config.js'

const lockFile = path.join(dirs.base, 'wa.lock')

/** Vivo e não zombie: `kill(pid, 0)` responde que sim a um zombie, e um zombie já não larga a sessão nem o terminal. */
function pidAlive(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.charAt(stat.lastIndexOf(')') + 2) !== 'Z'
  } catch {
    try { process.kill(pid, 0); return true } catch { return false }
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * Outros processos deste programa, pelo /proc: cobre instâncias que não escreveram o bloqueio (versões anteriores,
 * ficheiro apagado). Reconhece-se pelo caminho do script, absoluto ou relativo à mesma pasta do projecto.
 */
function runningInstances(): number[] {
  const script = path.resolve(process.argv[1] ?? '')
  const root = path.resolve(path.dirname(script), '..')
  const rel = path.relative(root, script)
  const found: number[] = []
  // Só instâncias do mesmo perfil (mesma pasta de dados): perfis diferentes são sessões WhatsApp diferentes e coexistem.
  const sameProfile = (pid: number): boolean => {
    let env: Record<string, string> = {}
    try {
      env = Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map(kv => {
        const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]
      }))
    } catch { return false }
    const home = env.HOME ?? os.homedir()
    const base = env.WA_HOME ?? path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'wa')
    return path.resolve(base) === path.resolve(dirs.base)
  }
  for (const entry of fs.readdirSync('/proc')) {
    const pid = Number(entry)
    if (!pid || pid === process.pid || pid === process.ppid) continue
    let args: string[]
    try { args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean) } catch { continue }
    // Só processos node (o nosso ou o wrapper do tsx) com o script como argumento inteiro: uma shell cuja linha de
    // comando mencione o caminho não é uma instância.
    if (!/^node(\.exe)?$/.test(path.basename(args[0] ?? ''))) continue
    let match = args.includes(script)
    if (!match && args.includes(rel)) {
      try { match = fs.readlinkSync(`/proc/${pid}/cwd`) === root } catch { continue }
    }
    if (match && sameProfile(pid)) found.push(pid)
  }
  return found
}

/**
 * Só uma instância por sessão: o WhatsApp expulsa a ligação anterior quando outra se liga com as mesmas credenciais, e
 * duas instâncias ficam a expulsar-se uma à outra sem que nenhuma consiga enviar. A instância nova manda a antiga
 * terminar (SIGTERM, que ela trata com `onSignal` para repor o terminal) e espera que saia. Devolve o pid da antiga
 * se ela não sair a tempo.
 */
export async function acquireLock(onSignal: () => void): Promise<number | null> {
  const others = new Set<number>(runningInstances())
  try { others.add(Number(fs.readFileSync(lockFile, 'utf8').trim())) } catch { /* sem lock */ }
  others.delete(process.pid); others.delete(process.ppid); others.delete(0)
  const alive = [...others].filter(pidAlive)
  if (alive.length) {
    for (const pid of alive) { try { process.kill(pid, 'SIGTERM') } catch { /* já morreu */ } }
    for (let i = 0; i < 30 && alive.some(pidAlive); i++) await sleep(100)
    // Quem ignorou o SIGTERM leva SIGKILL: é um processo nosso, e sem o fechar o WhatsApp não nos deixa ligar.
    for (const pid of alive.filter(pidAlive)) { try { process.kill(pid, 'SIGKILL') } catch { /* já morreu */ } }
    for (let i = 0; i < 10 && alive.some(pidAlive); i++) await sleep(100)
    const left = alive.find(pidAlive)
    if (left) return left
  }
  fs.writeFileSync(lockFile, String(process.pid))
  const release = () => { try { if (fs.readFileSync(lockFile, 'utf8').trim() === String(process.pid)) fs.unlinkSync(lockFile) } catch { /* já não existe */ } }
  process.on('exit', release)
  for (const sig of ['SIGTERM', 'SIGHUP'] as const) process.on(sig, onSignal)
  return null
}
