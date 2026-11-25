import { readdir } from 'node:fs/promises'
import type { Knex } from 'knex'
import { db, migrationsDir } from '../../db/index.js'
import { hasColumn } from '../../lib/column-probe.js'
import { apiLogSource } from '../api-log-source.js'
import { boundedRaw } from '../bounded-sql.js'
import { KNOWN_ENV_KEYS } from '../hub/docker/known-env.js'
import { instanceKey } from '../settings-overrides.js'

/**
 * App side of the Hub link, two read-only extras of GET /api/hub-link/status that the Hub's
 * release operations ask for (services/hub/releases/*). Aggregate counts and build facts only:
 * never a record, a path, a user, a query or a value.
 *
 *  - recent(minutes)  requests answered and 5xx answers in the request log, and front-end crash
 *                     reports filed, over the last `minutes` (1–60). The Hub's automatic
 *                     rollback rule judges them after a promotion. null when a count cannot be
 *                     read in time.
 *  - releaseFacts()   the migration names this build ships and the setting names it knows
 *                     (KNOWN_ENV_KEYS): the Hub diffs two versions' facts for release notes.
 */

export interface RecentFigures {
  minutes: number
  requests: number | null
  errors_5xx: number | null
  crashes: number | null
}

export { recentMinutesParam } from './release-params.js'

const num = (v: unknown): number | null => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** Each statement's own deadline, cancelled on the server when it passes (bounded-sql). */
export const RECENT_STATEMENT_MS = 3_000

export interface RecentDeps {
  /** Runs one read with its own cancelling deadline (tests pass a fake). */
  run(q: Knex.QueryBuilder): Promise<Array<Record<string, unknown>>>
  instance(): Promise<string | null>
}

function defaultRecentDeps(): RecentDeps {
  return {
    run: (q) => {
      const { sql, bindings } = q.toSQL()
      return boundedRaw(sql, bindings, { timeoutMs: RECENT_STATEMENT_MS })
    },
    // The request log's `instance` column (migration 379): several instances may share one
    // database, and only this one's answers are this app's. No column = every row.
    instance: async () =>
      (await hasColumn('nivaro_api_logs', 'instance')) ? instanceKey().slice(0, 60) : null
  }
}

/**
 * Counts over the last `minutes`: one read of the request log (WITH (NOLOCK) on SQL Server via
 * apiLogSource, this instance only, its own cancelling deadline) and one of client crash
 * occurrences. A read that fails or runs out of time is null.
 */
export async function recentFigures(
  minutes: number,
  deps: RecentDeps = defaultRecentDeps()
): Promise<RecentFigures> {
  const since = new Date(Date.now() - minutes * 60_000)
  const logs = async () => {
    const q = apiLogSource(db)
      .where('created_at', '>=', since)
      .select(
        db.raw('COUNT(*) AS n'),
        db.raw('SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS e')
      )
    const inst = await deps.instance()
    if (inst) q.where('instance', inst)
    const [row] = await deps.run(q)
    return { requests: num(row?.n), errors: num(row?.e) }
  }
  const crashes = async () => {
    const [row] = await deps.run(
      db('nivaro_issue_occurrences')
        .where('occurred_at', '>=', since)
        .where('source', 'client')
        .select(db.raw('COUNT(*) AS n'))
    )
    return num(row?.n)
  }
  const [l, c] = await Promise.all([
    logs().catch(() => ({ requests: null, errors: null })),
    crashes().catch(() => null)
  ])
  return { minutes, requests: l.requests, errors_5xx: l.errors, crashes: c }
}

/** What this build carries: its migration names (without extension) and known setting names. */
export async function releaseFacts(): Promise<{ migrations: string[]; env_keys: string[] }> {
  let migrations: string[] = []
  try {
    migrations = (await readdir(migrationsDir))
      .filter((f) => (f.endsWith('.ts') && !f.endsWith('.d.ts')) || f.endsWith('.js'))
      .map((f) => f.replace(/\.(ts|js)$/, ''))
      .filter((f, i, all) => all.indexOf(f) === i)
      .sort()
  } catch {
    migrations = []
  }
  return { migrations, env_keys: [...KNOWN_ENV_KEYS] }
}
