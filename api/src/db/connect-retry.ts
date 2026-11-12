/**
 * A login the server refuses while a pool opens a NEW connection is tried again for a few
 * seconds before any request hears of it.
 *
 * Why: a database that is briefly not taking logins (an ALTER DATABASE ... WITH ROLLBACK
 * IMMEDIATE, a failover, the moment after a restore) closes every pooled connection and answers
 * each new login with "Login failed". knex hands that error straight to the request that
 * needed the connection (tarn `propagateCreateError`), so every request in those seconds was a
 * 500, although the pool lets the same request wait ten seconds for a busy connection
 * (DB_ACQUIRE_TIMEOUT_MS) and the database was back well inside that.
 *
 * Why it is safe: nothing has been sent on a connection that never opened, so trying the open
 * again cannot repeat a write. It is the open that is retried, never a statement.
 *
 * Why it cannot hide an outage: only the driver's refused-login error is retried (not an
 * unreachable server, not a timeout), for at most BUDGET_MS, and the error that ends the
 * retries is thrown unchanged. The health probe keeps its own pool without this
 * (db/index.ts `probeDb`), so a database that stays away still trips the outage posture
 * (services/db-health.ts) on the same schedule as before.
 */

/** Waits before the second, third… attempt. */
const DELAYS_MS: readonly number[] = [250, 500, 1000, 2000, 3000]
/** No new attempt starts later than this after the first one began. Under the request pool's
 *  acquire timeout (10 s), so a request that was going to get a connection still does. */
const BUDGET_MS = 7000

export interface ConnectRetryOptions {
  delaysMs?: readonly number[]
  budgetMs?: number
  /** Tests: a clock and a sleep that do not wait. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onRetry?: (attempt: number, err: unknown) => void
}

/** The driver's "the server answered the login with an error" (tedious ConnectionError ELOGIN). */
export function isLoginRefused(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'ELOGIN'
}

let lastWarnAt = 0
/** One line per five seconds, however many connections are being opened. */
function warnRetry(attempt: number, err: unknown): void {
  const now = Date.now()
  if (now - lastWarnAt < 5000) return
  lastWarnAt = now
  const reason = String((err as { message?: unknown } | null)?.message ?? err).slice(0, 200)
  // biome-ignore lint/suspicious/noConsole: a database refusing logins must be visible in the log
  console.warn(
    `[db] the database refused a new connection (attempt ${attempt}) — trying again for a few seconds: ${reason}`
  )
}

/**
 * Run `open`; while it fails with a refused login, wait and run it again, inside the budget.
 * Any other error, and the last refused login, are rethrown as they are.
 */
export async function openWithLoginRetry<T>(
  open: () => Promise<T>,
  opts: ConnectRetryOptions = {}
): Promise<T> {
  const delays = opts.delaysMs ?? DELAYS_MS
  const budget = opts.budgetMs ?? BUDGET_MS
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const onRetry = opts.onRetry ?? warnRetry
  const started = now()
  for (let attempt = 0; ; attempt++) {
    try {
      return await open()
    } catch (err) {
      if (!isLoginRefused(err) || attempt >= delays.length) throw err
      const wait = delays[attempt]
      if (now() - started + wait > budget) throw err
      onRetry(attempt + 1, err)
      await sleep(wait)
    }
  }
}

const PATCHED = Symbol.for('nivaro.connectRetry')
type Opener = { acquireRawConnection?: () => Promise<unknown>; [PATCHED]?: boolean }

/**
 * Wrap THIS knex instance's connection open (the pool's `create` calls
 * `client.acquireRawConnection`). On the instance, never the driver prototype: the health
 * probe's pool shares the class and must keep failing at once.
 */
export function attachConnectRetry(
  knexInstance: { client?: unknown },
  opts: ConnectRetryOptions = {}
): void {
  const client = knexInstance.client as Opener | undefined
  if (!client || typeof client.acquireRawConnection !== 'function' || client[PATCHED]) return
  const original = client.acquireRawConnection
  client[PATCHED] = true
  client.acquireRawConnection = function retriedOpen(this: Opener) {
    return openWithLoginRetry(() => original.call(this), opts)
  }
}
