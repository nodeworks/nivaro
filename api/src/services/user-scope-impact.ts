import { db } from '../db/index.js'
import { boundedRaw, StatementCancelled } from './bounded-sql.js'
import { withReadGate } from './read-gate.js'
import { applyScopeHops, getUserScopes, type ScopeDimension, scopeHopsFor } from './user-scopes.js'

/**
 * Blast radius of a proposed RESTRICT change on one person's scope dimension
 * (POST /user-scopes/:userId/impact): on the biggest collections that route
 * to the dimension, how many rows they see now, how many they would see, and
 * which rows they gain or lose.
 *
 * Speed (2026-11-13, Rob: "Apply restriction is slow"): the collections used
 * to run one after another, six to eight statements each (2.2–9.7 s on
 * EFP_Development). Now:
 *   - up to IMPACT_CONCURRENCY collections at once, each holding its own
 *     heavy-read slot (services/read-gate.ts), and never more than
 *     IMPACT_STATEMENTS statements of one answer at once;
 *   - a collection's counts run side by side, then its two samples;
 *   - the samples skip the optimizer's row goal (see sampleStatement);
 *   - every statement has a deadline the server honours (bounded-sql.ts):
 *     when the budget is spent the rest is cancelled and the answer names the
 *     collections it could not finish (`partial`).
 * Folding the four counts into one statement (a CASE per figure) was tried
 * and measured 3–50x SLOWER: a per-row EXISTS cannot use the set-based plans
 * the separate counts get.
 * What is computed is unchanged: the same candidate order, the same five
 * collections, the same statements, the same newest-first samples.
 */

export type ScopeValue = string | number
export type ImpactSample = Array<{ id: string; label: string }>

export interface ScopeImpactRow {
  collection: string
  /** The collection's display name (additive; the UI shows it, never the table name). */
  label: string
  total: number
  current: number
  proposed: number
  gained: number
  lost: number
  gained_sample: ImpactSample
  lost_sample: ImpactSample
}

export interface ScopeImpactResult {
  dimension: string
  current_values: ScopeValue[]
  proposed_values: ScopeValue[]
  impact: ScopeImpactRow[]
  /** Collections the time budget cut before they finished (additive). */
  partial: Array<{ collection: string; label: string }>
}

export const IMPACT_LIMIT = 5
export const IMPACT_CONCURRENCY = 4
export const IMPACT_STATEMENTS = 6
export const IMPACT_BUDGET_MS = 8_000

// ─── which figures a change needs ────────────────────────────────────────────

/** A side of a figure: rows inside `inside` and outside `outside` (empty = no condition). */
export interface DiffSpec {
  inside: ScopeValue[]
  outside: ScopeValue[]
}

/**
 * The figures one collection needs. `null` = no statement: an empty allowance
 * counts the whole table (the partition-stats total), and a change that can
 * only narrow (or only widen) has nothing on the other side.
 */
export function planImpact(
  current: ScopeValue[],
  proposed: ScopeValue[]
): {
  current: ScopeValue[] | null
  proposed: ScopeValue[] | null
  gained: DiffSpec | null
  lost: DiffSpec | null
} {
  const side = (inside: ScopeValue[], outside: ScopeValue[]): DiffSpec | null =>
    inside.length === 0 && outside.length === 0 ? null : { inside, outside }
  return {
    current: current.length > 0 ? current : null,
    proposed: proposed.length > 0 ? proposed : null,
    // gained = proposed-visible ∖ current-visible; lost = the reverse. A move
    // to "everything" gains what the old set hid and loses nothing; a move
    // from "everything" gains nothing and loses what the new set hides.
    gained:
      proposed.length === 0 && current.length > 0
        ? side([], current)
        : proposed.length > 0 && current.length === 0
          ? null
          : side(proposed, current),
    lost:
      current.length === 0 && proposed.length > 0
        ? side([], proposed)
        : current.length > 0 && proposed.length === 0
          ? null
          : side(current, proposed)
  }
}

// ─── the candidate pool ──────────────────────────────────────────────────────

export type CandidateOutcome<R> = { kind: 'ok'; value: R } | { kind: 'skip' } | { kind: 'cut' }

/**
 * Run candidates in order, `concurrency` at a time, until `limit` succeeded.
 * A candidate starts only while the ones before it that succeeded, are still
 * running or were cut number fewer than `limit` — so the answer is exactly the
 * first `limit` successes of the serial loop, without running far past them.
 * Once `expired()` the work is still asked (it answers `skip` for a candidate
 * that never applied, `cut` for one it no longer has time for). `cut` lists the
 * candidates the deadline stopped that would otherwise have filled a place.
 */
export async function runCandidates<C, R>(
  candidates: C[],
  work: (c: C) => Promise<CandidateOutcome<R>>,
  opts: { limit: number; concurrency: number }
): Promise<{ ok: R[]; cut: C[] }> {
  const outcome: Array<CandidateOutcome<R> | 'running' | undefined> = new Array(candidates.length)
  let next = 0
  const aheadOf = (i: number) => {
    let n = 0
    for (let j = 0; j < i; j++) {
      const o = outcome[j]
      if (o && (o === 'running' || o.kind !== 'skip')) n++
    }
    return n
  }
  const runner = async (): Promise<void> => {
    while (next < candidates.length && aheadOf(next) < opts.limit) {
      const i = next++
      outcome[i] = 'running'
      try {
        outcome[i] = await work(candidates[i])
      } catch {
        outcome[i] = { kind: 'skip' }
      }
    }
  }
  // A runner stops when enough are ahead of the next candidate; a skip ahead
  // re-opens room, so go again until nothing more can start.
  do {
    await Promise.all(Array.from({ length: opts.concurrency }, runner))
  } while (next < candidates.length && aheadOf(next) < opts.limit)
  const ok: R[] = []
  const cut: C[] = []
  for (let i = 0; i < next && ok.length + cut.length < opts.limit; i++) {
    const o = outcome[i]
    if (!o || o === 'running') continue
    if (o.kind === 'ok') ok.push(o.value)
    else if (o.kind === 'cut') cut.push(candidates[i])
  }
  return { ok, cut }
}

// ─── SQL ─────────────────────────────────────────────────────────────────────

type Hops = NonNullable<Awaited<ReturnType<typeof scopeHopsFor>>>
type Stmt = { sql: string; bindings: unknown[] }

function isMssql(): boolean {
  return (
    (db as unknown as { client?: { config?: { client?: string } } }).client?.config?.client ===
    'mssql'
  )
}

/** Rows visible under one allowance (the statement the serial route ran). */
export function countStatement(table: string, hops: Hops, ids: ScopeValue[]): Stmt {
  const q = db(table).count({ n: '*' })
  applyScopeHops(q, table, hops, ids)
  const { sql, bindings } = q.toSQL()
  return { sql, bindings: [...bindings] }
}

function diffQuery(table: string, hops: Hops, d: DiffSpec) {
  const q = db(table)
  if (d.inside.length > 0) q.where((qb) => applyScopeHops(qb, table, hops, d.inside))
  if (d.outside.length > 0) q.whereNot((qb) => applyScopeHops(qb, table, hops, d.outside))
  return q
}

/** Rows on one side of the change. */
export function diffCountStatement(table: string, hops: Hops, d: DiffSpec): Stmt {
  const { sql, bindings } = diffQuery(table, hops, d).count({ n: '*' }).toSQL()
  return { sql, bindings: [...bindings] }
}

/**
 * Newest five ids on one side of the change. On SQL Server without the
 * optimizer's row goal: with TOP 5 it walks the id index backwards testing
 * every row against the NOT EXISTS, which took 7 s on invoices when the rows
 * that moved were old (division change on EFP_Development); without it the
 * plan is the count's plus a top-5 sort (~0.3 s). Same rows either way.
 */
export function sampleStatement(table: string, hops: Hops, d: DiffSpec): Stmt {
  const { sql, bindings } = diffQuery(table, hops, d)
    .select('id')
    .orderBy('id', 'desc')
    .limit(5)
    .toSQL()
  return {
    sql: isMssql() ? `${sql} OPTION (USE HINT('DISABLE_OPTIMIZER_ROWGOAL'))` : sql,
    bindings: [...bindings]
  }
}

/** A tiny FIFO limiter: at most `n` statements of one answer at once. */
export function limiter(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const queue: Array<() => void> = []
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => queue.push(r))
    active++
    try {
      return await fn()
    } finally {
      active--
      queue.shift()?.()
    }
  }
}

// ─── the whole answer ────────────────────────────────────────────────────────

interface Candidate {
  table: string
  label: string
  rows: number
}

/** Workflow-bound collections lead (the units admins think in), then the
 *  biggest remaining registered tables. */
async function candidateCollections(): Promise<Candidate[]> {
  const [counts, registeredRows, bound] = await Promise.all([
    db.raw(`
      SELECT t.name AS table_name, SUM(p.row_count) AS rows
      FROM sys.tables t
      JOIN sys.dm_db_partition_stats p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
      WHERE t.name NOT LIKE 'nivaro[_]%' AND t.name NOT LIKE 'directus[_]%' AND t.name NOT LIKE 'staging[_]%'
      GROUP BY t.name
      ORDER BY SUM(p.row_count) DESC
    `) as Promise<Array<{ table_name: string; rows: number }>>,
    db('nivaro_collections').select('collection', 'display_name', 'plural') as Promise<
      Array<{ collection: string; display_name?: string | null; plural?: string | null }>
    >,
    db('nivaro_workflow_bindings').distinct('collection') as Promise<Array<{ collection: string }>>
  ])
  const labelOf = new Map<string, string>()
  for (const r of registeredRows) {
    labelOf.set(
      r.collection.toLowerCase(),
      (r.plural || r.display_name || '').trim() || titleCase(r.collection)
    )
  }
  const countByName = new Map(counts.map((c) => [c.table_name.toLowerCase(), Number(c.rows)]))
  const ordered: Array<{ table_name: string; rows: number }> = []
  const seen = new Set<string>()
  for (const bc of bound) {
    const key = bc.collection.toLowerCase()
    if (seen.has(key) || !countByName.has(key)) continue
    seen.add(key)
    ordered.push({ table_name: bc.collection, rows: countByName.get(key) ?? 0 })
  }
  for (const c of counts) {
    const key = c.table_name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    ordered.push(c)
  }
  return ordered
    .filter((c) => labelOf.has(c.table_name.toLowerCase()))
    .map((c) => ({
      table: c.table_name,
      label: labelOf.get(c.table_name.toLowerCase()) as string,
      rows: Number(c.rows)
    }))
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
}

export async function computeScopeImpact(
  userId: string,
  dim: ScopeDimension,
  proposed: ScopeValue[],
  opts: { who?: string | null; signal?: AbortSignal; budgetMs?: number } = {}
): Promise<ScopeImpactResult> {
  const deadline = Date.now() + (opts.budgetMs ?? IMPACT_BUDGET_MS)
  const left = () => deadline - Date.now()
  const [rows, candidates] = await Promise.all([getUserScopes(userId), candidateCollections()])
  const currentRow = rows.find((r) => r.dimension === dim.name && r.mode === 'restrict')
  const current: ScopeValue[] = currentRow?.values ?? []
  const plan = planImpact(current, proposed)
  const { getLabels } = await import('./queues.js')

  // One answer never holds more than IMPACT_STATEMENTS connections at once.
  const limit = limiter(IMPACT_STATEMENTS)
  const run = async (s: Stmt) =>
    boundedRaw<Record<string, unknown>>(s.sql, s.bindings, {
      timeoutMs: Math.max(1, left()),
      signal: opts.signal
    })

  const sample = async (c: Candidate, hops: Hops, d: DiffSpec | null, count: number) => {
    if (!d || count === 0) return [] as ImpactSample
    const ids = (await limit(() => run(sampleStatement(c.table, hops, d)))).map((r) => String(r.id))
    // Labels make the sample recognisable; past the deadline they fall back to ids.
    let timer: ReturnType<typeof setTimeout> | undefined
    const labels = await Promise.race([
      getLabels(new Map([[c.table, new Set(ids)]])).catch(() => ({}) as Record<string, string>),
      new Promise<Record<string, string>>((r) => {
        timer = setTimeout(() => r({}), Math.max(1, left()))
      })
    ]).finally(() => clearTimeout(timer))
    return ids.map((id) => ({ id, label: labels[`${c.table}:${id}`] ?? `#${id}` }))
  }

  const work = async (c: Candidate): Promise<CandidateOutcome<ScopeImpactRow>> => {
    const hops = await scopeHopsFor(dim, c.table)
    if (hops === null) return { kind: 'skip' }
    if (left() <= 0 || opts.signal?.aborted) return { kind: 'cut' }
    return withReadGate(
      opts.who,
      async () => {
        // A slot that took the whole budget to come free has nothing left to spend.
        if (left() <= 0) return { kind: 'cut' } as const
        try {
          // The counts side by side, then the samples of the sides that moved.
          const count = async (st: Stmt | null) =>
            st ? Number((await limit(() => run(st)))[0]?.n ?? 0) : null
          const [cur, prop, gained, lost] = await Promise.all([
            count(plan.current ? countStatement(c.table, hops, plan.current) : null),
            count(plan.proposed ? countStatement(c.table, hops, plan.proposed) : null),
            count(plan.gained ? diffCountStatement(c.table, hops, plan.gained) : null),
            count(plan.lost ? diffCountStatement(c.table, hops, plan.lost) : null)
          ])
          const [gainedSample, lostSample] = await Promise.all([
            sample(c, hops, plan.gained, gained ?? 0),
            sample(c, hops, plan.lost, lost ?? 0)
          ])
          return {
            kind: 'ok',
            value: {
              collection: c.table,
              label: c.label,
              total: c.rows,
              current: cur ?? c.rows,
              proposed: prop ?? c.rows,
              gained: gained ?? 0,
              lost: lost ?? 0,
              gained_sample: gainedSample,
              lost_sample: lostSample
            }
          }
        } catch (e) {
          if (e instanceof StatementCancelled) return { kind: 'cut' }
          // a collection whose hops fail to compile is skipped, not fatal
          return { kind: 'skip' }
        }
      },
      { signal: opts.signal, label: 'scope-impact' }
    )
  }

  const { ok, cut } = await runCandidates(candidates, work, {
    limit: IMPACT_LIMIT,
    concurrency: IMPACT_CONCURRENCY
  })
  return {
    dimension: dim.name,
    current_values: current,
    proposed_values: proposed,
    impact: ok,
    partial: cut.map((c) => ({ collection: c.table, label: c.label }))
  }
}
