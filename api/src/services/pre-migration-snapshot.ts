/**
 * A config restore point before boot migrations (#2803).
 *
 * Boot runs pending migrations on its own (db/index.ts runMigrationsSafely). When at least one
 * is pending and the snapshot table exists, the configuration layer is stored first as a
 * 'pre-migration' snapshot naming the migrations about to run — a migration that rewrites
 * config rows (seeds, backfills, renames) can then be undone from Environment Config without
 * a database restore.
 *
 * It must never cost a boot: the WHOLE step (listing pending migrations, the table check, the
 * replica lock and the snapshot) is time-boxed (PRE_MIGRATION_SNAPSHOT_MS, default 30 s;
 * 0 = off), every failure is caught and logged, and a snapshot that runs out of time is
 * abandoned before it stores anything (a late row would capture the state AFTER the migrations).
 *
 * Replicas booting the same release together store ONE: the check-and-take runs under an
 * application lock (sp_getapplock 'nivaro:pre-migration-snapshot', no wait). A replica that
 * finds it held skips — the holder is taking the snapshot; one that gets it and finds a
 * pre-migration snapshot from the last ten minutes skips too (it was just taken).
 */

export type PreMigrationOutcome =
  | 'off'
  | 'none-pending'
  | 'no-table'
  | 'busy'
  | 'recent'
  | 'stored'
  | 'timeout'
  | 'failed'

export interface PreMigrationDeps {
  listPending: () => Promise<string[]>
  hasSnapshotTable: () => Promise<boolean>
  /** Run `fn` holding the replica lock; 'busy' when another replica holds it. */
  withLock: <T>(fn: () => Promise<T>) => Promise<T | 'busy'>
  /** A pre-migration snapshot stored within the last `withinMs`. */
  recentExists: (withinMs: number) => Promise<boolean>
  take: (pending: string[], signal: AbortSignal) => Promise<{ id: number }>
  log: (msg: string) => void
  timeoutMs: number
}

const RECENT_MS = 10 * 60_000
const DEFAULT_TIMEOUT_MS = 30_000

/** Exported for tests: the decision and its time box, with every dependency injected. */
export async function snapshotBeforeMigrationsWith(
  deps: PreMigrationDeps
): Promise<PreMigrationOutcome> {
  if (!(deps.timeoutMs > 0)) return 'off'
  const ac = new AbortController()
  const started = Date.now()
  const work = (async (): Promise<PreMigrationOutcome> => {
    const pending = await deps.listPending()
    if (pending.length === 0) return 'none-pending'
    if (!(await deps.hasSnapshotTable())) return 'no-table'
    const r = await deps.withLock(async () => {
      if (await deps.recentExists(RECENT_MS)) return 'recent' as const
      if (ac.signal.aborted) throw new Error('config snapshot aborted')
      return deps.take(pending, ac.signal)
    })
    if (r === 'busy') {
      deps.log('Config snapshot: another replica is storing the pre-migration restore point')
      return 'busy'
    }
    if (r === 'recent') {
      deps.log('Config snapshot: a pre-migration restore point from the last 10 minutes exists')
      return 'recent'
    }
    deps.log(
      `Config snapshot: restore point #${r.id} before ${pending.length} migration${pending.length === 1 ? '' : 's'} (${Date.now() - started} ms)`
    )
    return 'stored'
  })()
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      ac.abort()
      resolve('timeout')
    }, deps.timeoutMs)
    timer.unref?.()
  })
  try {
    const outcome = await Promise.race([work, timeout])
    if (outcome === 'timeout') {
      // The work may still be finishing a read; it stops at the next table and stores nothing.
      work.catch(() => {})
      deps.log(
        `Config snapshot: no pre-migration restore point — gave up after ${deps.timeoutMs} ms`
      )
    }
    return outcome
  } catch (err) {
    if (ac.signal.aborted) return 'timeout'
    deps.log(
      `Config snapshot: no pre-migration restore point — ${err instanceof Error ? err.message : String(err)}`
    )
    return 'failed'
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function timeoutFromEnv(): number {
  const raw = process.env.PRE_MIGRATION_SNAPSHOT_MS
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TIMEOUT_MS
}

/** Boot entry point: never throws. */
export async function snapshotBeforeMigrations(): Promise<PreMigrationOutcome> {
  try {
    const { db, isMssql, migrationSource } = await import('../db/index.js')
    return await snapshotBeforeMigrationsWith({
      timeoutMs: timeoutFromEnv(),
      listPending: async () => {
        const [, pending] = (await db.migrate.list()) as [unknown[], Array<unknown>]
        return pending.map((m) =>
          typeof m === 'string'
            ? migrationSource.getMigrationName(m)
            : String(
                (m as { name?: string; file?: string }).name ?? (m as { file?: string }).file ?? ''
              )
        )
      },
      hasSnapshotTable: () => db.schema.hasTable('nivaro_config_snapshots'),
      withLock: async (fn) => {
        if (!isMssql()) return fn()
        // A session lock on one pinned connection, held while the snapshot is taken.
        const { withLongConnection } = await import('./run-long.js')
        return withLongConnection(async (conn) => {
          const got = await conn.run<{ r: number }>(
            `DECLARE @r int;
             EXEC @r = sp_getapplock @Resource = N'nivaro:pre-migration-snapshot',
                  @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = 0;
             SELECT @r AS r;`,
            10_000
          )
          if (Number(got[0]?.r) < 0) return 'busy' as const
          try {
            return await fn()
          } finally {
            await conn
              .run(
                `EXEC sp_releaseapplock @Resource = N'nivaro:pre-migration-snapshot', @LockOwner = 'Session';`,
                10_000
              )
              .catch(() => conn.discard())
          }
        })
      },
      recentExists: async (withinMs) => {
        const row = await db('nivaro_config_snapshots')
          .where('trigger', 'pre-migration')
          .where('taken_at', '>=', new Date(Date.now() - withinMs))
          .first('id')
        return !!row
      },
      take: async (pending, signal) => {
        const { takeConfigSnapshot } = await import('./config-snapshots.js')
        const shown = pending.slice(0, 12).join(', ')
        return takeConfigSnapshot('pre-migration', {
          migrations: pending,
          signal,
          concurrency: 6,
          note: `Before migrations ${shown}${pending.length > 12 ? ` and ${pending.length - 12} more` : ''}`
        })
      },
      log: (msg) => console.log(msg)
    })
  } catch (err) {
    console.log(
      `Config snapshot: no pre-migration restore point — ${err instanceof Error ? err.message : String(err)}`
    )
    return 'failed'
  }
}
