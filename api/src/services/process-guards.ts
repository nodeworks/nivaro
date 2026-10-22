/**
 * A promise nobody awaited must never take the whole process down.
 *
 * Node's default for an unhandled rejection is to crash. On 2026-10-21 a web task crashed
 * that way while Redis restarted during a deploy: an ioredis command queued on the
 * socket.io adapter's client was flushed with MaxRetriesPerRequestError and nothing caught
 * it, so the task exited 1 mid-roll and the release rolled back. Requests already turn such
 * errors into 500s; a stray background rejection is logged (once a minute per message, so a
 * Redis outage does not flood the log) and the process keeps serving.
 *
 * Uncaught exceptions keep Node's default: the process state is unknown after one.
 */

type Log = { error: (obj: unknown, msg?: string) => void }

const WINDOW_MS = 60_000
const MAX_KEYS = 200

export function rejectionLogger(log: Log, now: () => number = Date.now) {
  const lastLogged = new Map<string, number>()
  let suppressed = 0
  return (reason: unknown): boolean => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    const key = `${err.name}:${err.message}`.slice(0, 300)
    const t = now()
    const last = lastLogged.get(key)
    if (last !== undefined && t - last < WINDOW_MS) {
      suppressed++
      return false
    }
    if (lastLogged.size >= MAX_KEYS) lastLogged.delete(lastLogged.keys().next().value as string)
    lastLogged.set(key, t)
    log.error(
      { err, suppressed_since_last: suppressed },
      'Unhandled promise rejection (kept running)'
    )
    suppressed = 0
    return true
  }
}

let installed = false

export function installProcessGuards(log: Log): void {
  if (installed) return
  installed = true
  const onRejection = rejectionLogger(log)
  process.on('unhandledRejection', (reason) => {
    onRejection(reason)
  })
}
