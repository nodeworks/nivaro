/**
 * A config restore point before boot migrations (#2803).
 *
 * Boot runs pending migrations on its own (db/index.ts runMigrationsSafely). When at least one
 * is pending and the snapshot table exists, the configuration layer is stored first as a
 * 'pre-migration' snapshot naming the migrations about to run — a migration that rewrites
 * config rows (seeds, backfills, renames) can then be undone from Environment Config without
 * a database restore.
 *
 * It must never cost a boot: time-boxed (PRE_MIGRATION_SNAPSHOT_MS, default 60 s; 0 = off),
 * every failure caught and logged, and a snapshot that runs out of time is abandoned before it
 * stores anything (a late row would capture the state AFTER the migrations). Replicas booting
 * the same release together store one: a pre-migration snapshot from the last ten minutes
 * counts.
 */

export type PreMigrationOutcome =
  | 'off'
  | 'none-pending'
  | 'no-table'
  | 'recent'
  | 'stored'
  | 'timeout'
  | 'failed'

export interface PreMigrationDeps {
  listPending: () => Promise<string[]>
  hasSnapshotTable: () => Promise<boolean>
  /** A pre-migration snapshot stored within the last `withinMs`. */
  recentExists: (withinMs: number) => Promise<boolean>
  take: (pending: string[], signal: AbortSignal) => Promise<{ id: number }>
  log: (msg: string) => void
  timeoutMs: number
}

const RECENT_MS = 10 * 60_000

/** Exported for tests: the decision and its time box, with every dependency injected. */
export async function snapshotBeforeMigrationsWith(
  deps: PreMigrationDeps
): Promise<PreMigrationOutcome> {
  if (!(deps.timeoutMs > 0)) return 'off'
  const ac = new AbortController()
  let timer: NodeJS.Timeout | null = null
  try {
    const pending = await deps.listPending()
    if (pending.length === 0) return 'none-pending'
    if (!(await deps.hasSnapshotTable())) return 'no-table'
    if (await deps.recentExists(RECENT_MS)) {
      deps.log('Config snapshot: a pre-migration restore point from the last 10 minutes exists')
      return 'recent'
    }
    const started = Date.now()
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        ac.abort()
        resolve('timeout')
      }, deps.timeoutMs)
      timer.unref?.()
    })
    const outcome = await Promise.race([deps.take(pending, ac.signal).then((m) => m), timeout])
    if (outcome === 'timeout') {
      deps.log(
        `Config snapshot: no pre-migration restore point — gave up after ${deps.timeoutMs} ms`
      )
      return 'timeout'
    }
    deps.log(
      `Config snapshot: restore point #${outcome.id} before ${pending.length} migration${pending.length === 1 ? '' : 's'} (${Date.now() - started} ms)`
    )
    return 'stored'
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
  if (raw === undefined || raw === '') return 60_000
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 60_000
}

/** Boot entry point: never throws. */
export async function snapshotBeforeMigrations(): Promise<PreMigrationOutcome> {
  try {
    const { db, migrationSource } = await import('../db/index.js')
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
