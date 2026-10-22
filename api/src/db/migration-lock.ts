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
