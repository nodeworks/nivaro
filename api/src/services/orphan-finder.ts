// api/src/services/orphan-finder.ts
/**
 * Orphan finder, database half (pure half: orphan-finder-logic.ts). Data Integrity →
 * Orphans (routes/orphans.ts, admin only).
 *
 * - The check list is built from nivaro_relations + nivaro_fields judged against the live
 *   schema (information_schema + sys.foreign_keys), cached 60 s per tenant.
 * - Every scan is ONE set-based statement with a server-side deadline (boundedRaw cancels
 *   it on SQL Server), taken inside the heavy-read gate.
 * - The full sweep runs in the background on the background pool, one check at a time,
 *   recorded as a job run; its state lives in Redis (any replica answers) with an
 *   in-process fallback, keyed by tenant. One sweep per tenant at a time (a lease).
 * - Repairs never run here: routes/orphans.ts sends each row through the items service.
 */
import type { Knex } from 'knex'
import { isMssql } from '../db/dialect.js'
import { resolveDb } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import { boundedRaw, StatementCancelled } from './bounded-sql.js'
import { startJobRun } from './job-runs.js'
import {
  buildOrphanChecks,
  type ColumnFact,
  countSql,
  type FieldFact,
  type OrphanCheck,
  orphanPredicate,
  type RelationFact,
  type SchemaFacts,
  type SkippedLink,
  sampleSql
} from './orphan-finder-logic.js'
import { withReadGate } from './read-gate.js'
import { currentTenantKey } from './tenant-rooms.js'

/** One scan on a request (a single check). */
export const CHECK_TIMEOUT_MS = 20_000
/** One scan inside the background sweep. */
export const SWEEP_CHECK_TIMEOUT_MS = 90_000
export const SAMPLE_ROWS = 10
const SWEEP_TTL_S = 7 * 24 * 3600
const LEASE_TTL_S = 2 * 3600

// ── schema facts ─────────────────────────────────────────────────────────────

export async function loadSchemaFacts(knex: Knex): Promise<SchemaFacts> {
  const mssql = isMssql(knex)
  const cols = (await knex.raw(
    `SELECT c.TABLE_NAME AS t, c.COLUMN_NAME AS c, c.DATA_TYPE AS d, c.IS_NULLABLE AS n
       FROM INFORMATION_SCHEMA.COLUMNS c
       JOIN INFORMATION_SCHEMA.TABLES t
         ON t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_SCHEMA = c.TABLE_SCHEMA
      WHERE t.TABLE_TYPE = 'BASE TABLE'${mssql ? " AND c.TABLE_SCHEMA = 'dbo'" : ''}`
  )) as unknown
  const tables = new Map<string, Map<string, ColumnFact>>()
  for (const r of rowsOf<{ t: string; c: string; d: string; n: string }>(cols)) {
    let m = tables.get(r.t)
    if (!m) {
      m = new Map()
      tables.set(r.t, m)
    }
    m.set(r.c, { type: String(r.d), nullable: String(r.n).toUpperCase() === 'YES' })
  }
  const pkRows = rowsOf<{ t: string; c: string }>(
    await knex.raw(
      `SELECT k.TABLE_NAME AS t, k.COLUMN_NAME AS c
         FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
           ON k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND k.TABLE_NAME = tc.TABLE_NAME
        WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'`
    )
  )
  const pkCols = new Map<string, string[]>()
  for (const r of pkRows) pkCols.set(r.t, [...(pkCols.get(r.t) ?? []), r.c])
  const pk = new Map<string, string>()
  for (const [t, c] of pkCols) if (c.length === 1) pk.set(t, c[0])

  const enforced = new Set<string>()
  const referencedBy = new Map<string, string[]>()
  if (mssql) {
    // Physical foreign keys: a trusted, enabled one means the link cannot dangle (no scan);
    // any one INTO a table means its rows are not deleted from here.
    const fks = rowsOf<{ t: string; c: string; rt: string; dis: unknown; nt: unknown }>(
      await knex
        .raw(
          `SELECT OBJECT_NAME(fk.parent_object_id) AS t,
                  COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS c,
                  OBJECT_NAME(fk.referenced_object_id) AS rt,
                  fk.is_disabled AS dis, fk.is_not_trusted AS nt
             FROM sys.foreign_keys fk
             JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id`
        )
        .catch(() => [])
    )
    for (const f of fks) {
      if (!truthy(f.dis) && !truthy(f.nt)) enforced.add(`${f.t}.${f.c}`.toLowerCase())
      referencedBy.set(f.rt, [...(referencedBy.get(f.rt) ?? []), `${f.t}.${f.c}`])
    }
  }
  return { tables, pk, enforced, referencedBy, mssql }
}

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === '1'
}

function rowsOf<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[]
  const rows = (res as { rows?: T[] } | null)?.rows
  return Array.isArray(rows) ? rows : []
}

// ── the check list (60 s per tenant) ─────────────────────────────────────────

export interface CheckList {
  checks: OrphanCheck[]
  skipped: SkippedLink[]
  built_at: number
}
const listCache = new Map<string, CheckList>()

export async function loadOrphanChecks(opts: { fresh?: boolean } = {}): Promise<CheckList> {
  const tenant = currentTenantKey()
  const hit = listCache.get(tenant)
  if (!opts.fresh && hit && Date.now() - hit.built_at < 60_000) return hit
  const knex = resolveDb() as unknown as Knex
  const [relations, fields, facts] = await Promise.all([
    knex('nivaro_relations').select(
      'many_collection',
      'many_field',
      'one_collection',
      'one_field',
      'junction_field'
    ) as Promise<RelationFact[]>,
    loadFieldFacts(knex),
    loadSchemaFacts(knex)
  ])
  const built = { ...buildOrphanChecks(relations, fields, facts), built_at: Date.now() }
  listCache.set(tenant, built)
  return built
}

async function loadFieldFacts(knex: Knex): Promise<FieldFact[]> {
  // db_column arrived later than the table; a database without it reads plain field names.
  try {
    return (await knex('nivaro_fields').select(
      'collection',
      'field',
      'interface',
      'special',
      'db_column'
    )) as FieldFact[]
  } catch {
    const rows = (await knex('nivaro_fields').select(
      'collection',
      'field',
      'interface',
      'special'
    )) as Array<Omit<FieldFact, 'db_column'>>
    return rows.map((r) => ({ ...r, db_column: null }))
  }
}

export async function findCheck(key: string): Promise<OrphanCheck | null> {
  const list = await loadOrphanChecks()
  return list.checks.find((c) => c.key === key) ?? null
}

// ── one scan ─────────────────────────────────────────────────────────────────

export interface CheckResult {
  key: string
  orphans: number | null
  samples: Array<{ id: string; fk_value: string }>
  ms: number
  at: number
  /** The database enforces the link; nothing was scanned. */
  enforced?: boolean
  error?: string
}

/** Count + newest samples for one check, each statement time-boxed on the server. */
export async function inspectCheck(
  check: OrphanCheck,
  opts: { timeoutMs: number; signal?: AbortSignal; sample?: number }
): Promise<CheckResult> {
  const started = Date.now()
  if (check.enforced)
    return { key: check.key, orphans: 0, samples: [], ms: 0, at: started, enforced: true }
  const knex = resolveDb() as unknown as Knex
  const count = countSql(check)
  const [row] = await boundedRaw<{ n: unknown }>(count.sql, count.bindings, {
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    knex
  })
  const orphans = Number(row?.n ?? 0)
  let samples: CheckResult['samples'] = []
  if (orphans > 0) {
    const left = Math.max(1_000, opts.timeoutMs - (Date.now() - started))
    const s = sampleSql(check, opts.sample ?? SAMPLE_ROWS, isMssql(knex))
    samples = (
      await boundedRaw<{ row_id: unknown; fk_value: unknown }>(s.sql, s.bindings, {
        timeoutMs: left,
        signal: opts.signal,
        knex
      })
    ).map((r) => ({ id: String(r.row_id), fk_value: String(r.fk_value) }))
  }
  return { key: check.key, orphans, samples, ms: Date.now() - started, at: Date.now() }
}

export function describeScanError(err: unknown): string {
  if (err instanceof StatementCancelled)
    return err.reason === 'timeout' ? 'Took too long; skipped' : 'Stopped'
  return 'Could not be read'
}

/**
 * Which of `ids` still point at nothing right now (read without the sweep's samples: the
 * page's list may be minutes old). Up to 500 ids; ids that no longer dangle drop out.
 */
export async function stillOrphaned(check: OrphanCheck, ids: string[]): Promise<string[]> {
  const list = [...new Set(ids.map(String))].slice(0, 500)
  if (list.length === 0 || check.enforced) return []
  const knex = resolveDb() as unknown as Knex
  const p = orphanPredicate(check)
  const rows = rowsOf<{ id: unknown }>(
    await knex.raw(
      `SELECT c.?? AS id FROM ?? c WHERE c.?? IN (${list.map(() => '?').join(', ')}) AND ${p.sql}`,
      [check.child_pk, check.child, check.child_pk, ...list, ...p.bindings]
    )
  )
  const found = new Set(rows.map((r) => String(r.id).toLowerCase()))
  return list.filter((id) => found.has(id.toLowerCase()))
}

// ── the sweep ────────────────────────────────────────────────────────────────

export interface SweepState {
  id: string
  status: 'running' | 'done' | 'cancelled' | 'error'
  by: string | null
  started_at: number
  finished_at: number | null
  total: number
  done: number
  /** The check being scanned now. */
  current: string | null
  results: Record<string, CheckResult>
  error?: string
}

type RedisLike = {
  get(key: string): Promise<string | null>
  setex(key: string, ttl: number, value: string): Promise<unknown>
  set(...args: Array<string | number>): Promise<unknown>
  del(key: string): Promise<unknown>
}

const tenantPart = () => currentTenantKey() || '-'
const stateKey = () => `nvr:orphans:${tenantPart()}:sweep`
const leaseKey = () => `nvr:orphans:${tenantPart()}:lease`
const cancelKey = (id: string) => `nvr:orphans:${tenantPart()}:cancel:${id}`

const mem = new Map<string, { v: string; exp: number }>()
function memGet(k: string): string | null {
  const e = mem.get(k)
  if (!e) return null
  if (e.exp < Date.now()) {
    mem.delete(k)
    return null
  }
  return e.v
}

export interface SweepStore {
  load(): Promise<SweepState | null>
  save(s: SweepState): Promise<void>
  /** True when this caller got the lease. */
  claim(id: string): Promise<boolean>
  release(id: string): Promise<void>
  cancelled(id: string): Promise<boolean>
  cancel(id: string): Promise<void>
}

export function sweepStore(redis: RedisLike | null | undefined): SweepStore {
  const sk = stateKey()
  const lk = leaseKey()
  const get = async (k: string) => {
    if (redis) {
      try {
        return await redis.get(k)
      } catch {
        /* memory below */
      }
    }
    return memGet(k)
  }
  return {
    async load() {
      const raw = await get(sk)
      if (!raw) return null
      try {
        return JSON.parse(raw) as SweepState
      } catch {
        return null
      }
    },
    async save(s) {
      const v = JSON.stringify(s)
      mem.set(sk, { v, exp: Date.now() + SWEEP_TTL_S * 1000 })
      if (redis) await redis.setex(sk, SWEEP_TTL_S, v).catch(() => {})
    },
    async claim(id) {
      if (redis) {
        try {
          return (await redis.set(lk, id, 'EX', LEASE_TTL_S, 'NX')) === 'OK'
        } catch {
          /* memory below */
        }
      }
      if (memGet(lk)) return false
      mem.set(lk, { v: id, exp: Date.now() + LEASE_TTL_S * 1000 })
      return true
    },
    async release(id) {
      if (memGet(lk) === id) mem.delete(lk)
      if (redis && (await get(lk)) === id) await redis.del(lk).catch(() => {})
    },
    async cancelled(id) {
      return (await get(cancelKey(id))) != null
    },
    async cancel(id) {
      const k = cancelKey(id)
      mem.set(k, { v: '1', exp: Date.now() + 3_600_000 })
      if (redis) await redis.setex(k, 3600, '1').catch(() => {})
    }
  }
}

/**
 * The sweep loop, with its effects passed in (tests drive it with fakes). Scans one check at
 * a time, saves after each, stops between checks when cancelled. A check that fails or runs
 * out of time is recorded with its reason and the sweep goes on.
 */
export async function runSweepLoop(opts: {
  state: SweepState
  checks: OrphanCheck[]
  store: Pick<SweepStore, 'save' | 'cancelled'>
  inspect: (check: OrphanCheck) => Promise<CheckResult>
  onProgress?: (s: SweepState) => void
}): Promise<SweepState> {
  const { state, checks, store } = opts
  for (const check of checks) {
    if (await store.cancelled(state.id)) {
      state.status = 'cancelled'
      break
    }
    state.current = check.key
    await store.save(state)
    let result: CheckResult
    try {
      result = await opts.inspect(check)
    } catch (err) {
      result = {
        key: check.key,
        orphans: null,
        samples: [],
        ms: 0,
        at: Date.now(),
        error: describeScanError(err)
      }
    }
    state.results[check.key] = result
    state.done++
    opts.onProgress?.(state)
  }
  if (state.status === 'running') state.status = 'done'
  state.current = null
  state.finished_at = Date.now()
  await store.save(state)
  return state
}

/** Start a sweep in the background. `started: false` when one is already running. */
export async function startSweep(
  redis: RedisLike | null | undefined,
  userId: string
): Promise<{ started: boolean; state: SweepState | null }> {
  const store = sweepStore(redis)
  const id = `sw_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  if (!(await store.claim(id))) return { started: false, state: await store.load() }
  const list = await loadOrphanChecks({ fresh: true })
  const state: SweepState = {
    id,
    status: 'running',
    by: userId,
    started_at: Date.now(),
    finished_at: null,
    total: list.checks.length,
    done: 0,
    current: null,
    results: {}
  }
  await store.save(state)
  void runInBackgroundPool(async () => {
    const run = await startJobRun('monitor', 'orphan-sweep', {
      label: 'Orphan sweep',
      triggeredBy: userId
    })
    try {
      const end = await runSweepLoop({
        state,
        checks: list.checks,
        store,
        inspect: (check) =>
          withReadGate(
            userId,
            () => inspectCheck(check, { timeoutMs: SWEEP_CHECK_TIMEOUT_MS, sample: SAMPLE_ROWS }),
            { label: 'orphans:sweep' }
          ),
        onProgress: (s) => run.progress({ done: s.done, total: s.total })
      })
      const found = Object.values(end.results).filter((r) => (r.orphans ?? 0) > 0).length
      await run.complete(
        end.status === 'cancelled'
          ? `Stopped after ${end.done} of ${end.total} links`
          : `${found} of ${end.total} links have orphans`,
        { href: '/data-integrity/orphans' }
      )
    } catch (err) {
      state.status = 'error'
      state.error = 'The sweep stopped unexpectedly'
      state.finished_at = Date.now()
      await store.save(state).catch(() => {})
      await run.fail(err)
    } finally {
      await store.release(id).catch(() => {})
    }
  })
  return { started: true, state }
}
