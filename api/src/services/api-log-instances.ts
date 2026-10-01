import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { instanceKey } from './settings-overrides.js'

/**
 * #1052 — request-log rows written by DEVELOPMENT instances.
 *
 * Dev laptops and staging share one database, so every probe, throwaway API
 * and laptop session lands in nivaro_api_logs beside staging's real traffic —
 * as caller cards on Integration Health, auth failures, slow routes — for the
 * full 14-day retention. Each row carries the instance that served it
 * (migration 379: NIVARO_INSTANCE, else NODE_ENV), so dev rows are
 * recognisable by name:
 *
 *   - `development` and `test` — what NODE_ENV gives a laptop or a test run;
 *   - anything in API_LOGS_DEV_INSTANCES (comma list) — a laptop that sets its
 *     own NIVARO_INSTANCE;
 *   - this process's own key when it runs with NODE_ENV=development.
 *
 * A process NOT in development never counts its own key as dev, whatever the
 * list says: a deployment can never prune or hide its own traffic. Rows from
 * before migration 379 (instance NULL) are deployed traffic as far as this
 * rule goes — they are left to the normal 14-day retention.
 *
 * Dev rows are pruned after 3 hours (API_LOGS_DEV_TTL_HOURS; 0 = never) —
 * long enough to read a probe's results back, short enough that staging's
 * screens stay staging's —
 * and API Analytics hides them unless asked (`?instances=all`).
 */
export const DEV_LOG_TTL_MS = 3 * 60 * 60 * 1000

/** API_LOGS_DEV_TTL_HOURS overrides the 3 hours; 0 turns the pruning off. */
export function devLogTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.API_LOGS_DEV_TTL_HOURS
  if (raw === undefined || raw.trim() === '') return DEV_LOG_TTL_MS
  const h = Number(raw)
  return Number.isFinite(h) && h > 0 ? h * 60 * 60 * 1000 : 0
}
const DEFAULT_DEV = ['development', 'test']

export function devInstanceKeys(
  env: NodeJS.ProcessEnv = process.env,
  own: string = instanceKey()
): string[] {
  const keys = new Set(DEFAULT_DEV)
  for (const k of (env.API_LOGS_DEV_INSTANCES ?? '').split(',')) {
    const t = k.trim()
    if (t) keys.add(t.slice(0, 60))
  }
  const ownKey = own.slice(0, 60)
  if (env.NODE_ENV === 'development') keys.add(ownKey)
  else keys.delete(ownKey)
  return [...keys]
}

/** True when the request asked for every instance (`?instances=all`). */
export function wantsAllInstances(query: unknown): boolean {
  return (query as { instances?: unknown } | null)?.instances === 'all'
}

/**
 * The scope a request reads with: `apply(qb, col)` narrows a knex query to
 * deployed instances, `sql` is the same condition for a raw query (with its
 * bindings). Both are no-ops when the request asked for all instances or the
 * database is behind migration 379.
 */
export async function instanceScope(query: unknown): Promise<{
  all: boolean
  apply: (qb: Knex.QueryBuilder, col?: string) => Knex.QueryBuilder
  sql: (col?: string) => string
  bindings: string[]
}> {
  const all = wantsAllInstances(query) || !(await hasColumn('nivaro_api_logs', 'instance'))
  const keys = devInstanceKeys()
  if (all || keys.length === 0) {
    return { all: true, apply: (qb) => qb, sql: () => '', bindings: [] }
  }
  return {
    all: false,
    apply: (qb, col = 'instance') => qb.where((w) => w.whereNull(col).orWhereNotIn(col, keys)),
    sql: (col = 'instance') =>
      ` AND (${col} IS NULL OR ${col} NOT IN (${keys.map(() => '?').join(', ')}))`,
    bindings: keys
  }
}

/**
 * Delete dev-instance rows older than the TTL, 2,000 at a time (an unbounded
 * DELETE over a busy table would hold locks and time out), at most `rounds`
 * batches per call. Returns how many rows went.
 */
export async function pruneDevInstanceLogs(
  opts: { now?: number; rounds?: number; dryRun?: boolean; keys?: string[] } = {}
): Promise<number> {
  const ttl = devLogTtlMs()
  if (ttl === 0) return 0
  if (!(await hasColumn('nivaro_api_logs', 'instance'))) return 0
  const keys = opts.keys ?? devInstanceKeys()
  if (keys.length === 0) return 0
  const cutoff = new Date((opts.now ?? Date.now()) - ttl)
  if (opts.dryRun) {
    const row = (await db('nivaro_api_logs')
      .whereIn('instance', keys)
      .where('created_at', '<', cutoff)
      .count('* as n')
      .first()) as { n?: number | string } | undefined
    return Number(row?.n ?? 0)
  }
  let total = 0
  for (let i = 0; i < (opts.rounds ?? 10); i++) {
    // A raw DELETE through knex/mssql answers no usable row count (measured:
    // rows went, the result read 0) — ask for @@ROWCOUNT in the same batch.
    const res = (await db.raw(
      `DELETE TOP (2000) FROM nivaro_api_logs WHERE instance IN (${keys.map(() => '?').join(', ')}) AND created_at < ?; SELECT @@ROWCOUNT AS n`,
      [...keys, cutoff]
    )) as Array<{ n?: number | string }> | unknown
    const affected = Number(Array.isArray(res) ? (res[0]?.n ?? 0) : 0) || 0
    total += affected
    if (affected < 2000) break
  }
  return total
}
