/**
 * Container HEALTHCHECK: a TCP connect to the agent's own listen port.
 * `/v1/health` needs the bearer token, and this process never reads it. Exits
 * 0 when the port accepts, 1 otherwise; prints nothing.
 */
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { DEFAULT_LISTEN, parseListen } from './config.js'

/** Where to connect: a wildcard bind answers on its loopback twin. */
export function healthTarget(env: NodeJS.ProcessEnv): { host: string; port: number } {
  const { host, port } = parseListen(env.HUB_AGENT_LISTEN?.trim() || DEFAULT_LISTEN)
  if (host === '0.0.0.0') return { host: '127.0.0.1', port }
  if (host === '::') return { host: '::1', port }
  return { host, port }
}

export function probe(target: { host: string; port: number }, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(target)
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let target: { host: string; port: number }
  try {
    target = healthTarget(process.env)
  } catch {
    process.exit(1)
  }
  void probe(target).then((ok) => process.exit(ok ? 0 : 1))
}
