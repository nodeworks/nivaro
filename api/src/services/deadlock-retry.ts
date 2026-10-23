/**
 * Deadlock victims (SQL Server 1205, Postgres 40P01, MySQL 1213) — the statement was rolled back
 * by the server and running it again is the documented remedy. For reads and idempotent
 * writes only.
 */
export function isDeadlockError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as {
    number?: unknown
    code?: unknown
    errno?: unknown
    message?: unknown
    originalError?: { info?: { number?: unknown }; number?: unknown }
  }
  const n = Number(e.number ?? e.originalError?.info?.number ?? e.originalError?.number)
  if (n === 1205) return true
  if (e.code === '40P01' || Number(e.errno) === 1213) return true
  return typeof e.message === 'string' && /deadlock(ed)? victim|deadlock detected/i.test(e.message)
}

/**
 * Run `fn`; when it loses a deadlock, wait a short jittered moment and run it again (up to
 * `retries` more times). Any other error, and the last deadlock, are rethrown unchanged.
 */
export async function withDeadlockRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseDelayMs?: number } = {}
): Promise<T> {
  const retries = Math.max(0, opts.retries ?? 1)
  const base = Math.max(0, opts.baseDelayMs ?? 50)
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= retries || !isDeadlockError(err)) throw err
      const wait = base * (attempt + 1) + Math.floor(Math.random() * base)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    }
  }
}
