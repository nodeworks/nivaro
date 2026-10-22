/** knex's MigrationLocked, by name or by its one message — kept free of any
 *  db import so the boot path's lock handling is unit-testable. */
export function isMigrationLockedError(err: unknown): boolean {
  const e = err as { name?: unknown; message?: unknown } | null
  return (
    e?.name === 'MigrationLocked' ||
    (typeof e?.message === 'string' && /migration table is already locked/i.test(e.message))
  )
}

export interface StaleLockOptions {
  latest: () => Promise<unknown>
  forceFree: () => Promise<unknown>
  /** MIGRATION_LOCK_STALE_MS: how long a held lock is waited on before it is freed. */
  budgetMs: number
  retryMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (msg: string) => void
}

/**
 * Run `latest`; while knex reports its migration lock held, retry every
 * retryMs, and once budgetMs has passed free the lock and run once more
 * (#2839). Kept free of any db import so the drill can test it with a mock.
 */
export async function migrateFreeingStaleLock({
  latest,
  forceFree,
  budgetMs,
  retryMs = 5000,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = (m) => console.warn(m)
}: StaleLockOptions): Promise<unknown> {
  const started = now()
  for (;;) {
    try {
      return await latest()
    } catch (err) {
      if (!isMigrationLockedError(err)) throw err
      const waited = now() - started
      if (waited >= budgetMs) {
        log(
          `Migration table locked for ${Math.round(waited / 1000)}s with no migration finishing — a prior process died mid-migration. Freeing the stale lock and running pending migrations.`
        )
        await forceFree()
        return await latest()
      }
      log(
        `Migration table is locked — another instance may be migrating; retrying in 5s (${Math.round((budgetMs - waited) / 1000)}s before the lock is treated as stale)`
      )
      await sleep(retryMs)
    }
  }
}

/** One pinned database session (services/run-long.ts `withLongConnection`). */
export interface PinnedSession {
  run<T = Record<string, unknown>>(sql: string, timeoutMs?: number): Promise<T[]>
  /** Close the session instead of handing it back to the pool. */
  discard(): void
}

export interface SessionAppLockOptions {
  /** sp_getapplock resource: letters, digits and underscores only (it is sent as text). */
  resource: string
  /** How long to wait for the lock (MIGRATION_LOCK_TIMEOUT_MS). */
  timeoutMs: number
}

/**
 * Run `fn` holding a session-owned SQL Server application lock taken AND released on
 * the one pinned session. A session lock taken by one pooled query and released by
 * another lands on whichever connection the pool hands out: the release then fails
 * (swallowed), and the lock stays with an idle pooled connection until the pool reaps it
 * (30 s) or for the life of the process. A replica booting meanwhile waited on it and,
 * because the wait ran under the 15 s request timeout, died with ETIMEOUT
 * (staging deploy 0.3.2 rolled back, 2026-10-22). Here the wait gets its own request
 * timeout (lock timeout + 30 s), and a release that fails closes the session, which
 * frees the lock.
 */
export async function underSessionAppLock<R>(
  session: PinnedSession,
  { resource, timeoutMs }: SessionAppLockOptions,
  fn: () => Promise<R>
): Promise<R> {
  if (!/^\w{1,255}$/.test(resource)) throw new Error(`Invalid app lock resource: ${resource}`)
  const wait = Math.max(0, Math.floor(timeoutMs))
  const [row] = await session.run<{ result: number }>(
    `DECLARE @r INT;
     EXEC @r = sp_getapplock @Resource = N'${resource}', @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = ${wait};
     SELECT @r AS result;`,
    wait + 30_000
  )
  if (!row || Number(row.result) < 0) {
    throw new Error(
      `Could not acquire the migration advisory lock within ${wait}ms — another instance may be stuck mid-migration.`
    )
  }
  try {
    return await fn()
  } finally {
    await session
      .run(`EXEC sp_releaseapplock @Resource = N'${resource}', @LockOwner = 'Session'`, 30_000)
      .catch(() => session.discard())
  }
}
