import { randomUUID } from 'node:crypto'
import { db } from '../../db/index.js'
import { getApp } from '../io-holder.js'
import type { FaultParams, FaultTarget, HypothesisRule } from './catalog.js'
import { CHAOS_KEY_PREFIX } from './registry.js'

/**
 * The chaos run store (#2827): every drill, monkey pick, game-day step and CI run as a row with
 * a timeline of events. Three backings, picked per call: the 497 tables when the database has
 * them; otherwise Redis (`nvr:chaos:run:*`, 7 days — the console still works on a database
 * behind the migration); otherwise this process's memory (tests, Redis down). Every write is
 * best effort — bookkeeping never breaks a drill.
 */

export type RunKind = 'drill' | 'monkey' | 'gameday' | 'ci'
export type RunStatus =
  | 'planned'
  | 'preflight'
  | 'running'
  | 'aborted'
  | 'stopped'
  | 'completed'
  | 'refused'
export type Verdict = 'held' | 'broke' | 'aborted'
export type RunEventKind =
  | 'armed'
  | 'disarmed'
  | 'sample'
  | 'alert'
  | 'readiness'
  | 'note'
  | 'abort'
  | 'stop'
  | 'step'

export interface ChaosRun {
  id: string
  kind: RunKind
  status: RunStatus
  fault_key: string | null
  label: string
  target: FaultTarget | null
  params: FaultParams
  hypothesis: HypothesisRule[]
  verdict: Verdict | null
  verdict_detail: Record<string, unknown> | null
  baseline: Record<string, unknown> | null
  started_by: string | null
  started_at: string | null
  ends_at: string | null
  ended_at: string | null
  preset_id: string | null
  gameday_id: string | null
  /** Free-form: started_by_name, job_run_id, preflight, override, node, metrics (record-only)… */
  meta: Record<string, unknown>
  created_at: string
}

export interface ChaosRunEvent {
  id: number
  run_id: string
  at: string
  kind: RunEventKind
  actor: string | null
  data: Record<string, unknown>
}

export type RunStoreMode = 'db' | 'redis' | 'memory'

const RUNS_TABLE = 'nivaro_chaos_runs'
const EVENTS_TABLE = 'nivaro_chaos_run_events'
const RUN_KEY = `${CHAOS_KEY_PREFIX}run:`
const RUNS_LIST = `${CHAOS_KEY_PREFIX}runs`
const RUN_TTL_S = 7 * 86_400
const RUNS_KEEP = 200
const EVENTS_KEEP = 3000

// ─── Backing selection ────────────────────────────────────────────────────────

let tableSeen: { at: number; has: boolean } | null = null
let forcedMode: RunStoreMode | null = null

async function hasTables(): Promise<boolean> {
  if (forcedMode) return forcedMode === 'db'
  if (tableSeen && Date.now() - tableSeen.at < 60_000) return tableSeen.has
  let has = false
  try {
    has = (await db.schema.hasTable(RUNS_TABLE)) && (await db.schema.hasTable(EVENTS_TABLE))
  } catch {
    has = false
  }
  tableSeen = { at: Date.now(), has }
  return has
}

interface RedisLike {
  get(k: string): Promise<string | null>
  set(k: string, v: string, ex: 'EX', s: number): Promise<unknown>
  lpush(k: string, v: string): Promise<unknown>
  ltrim(k: string, a: number, b: number): Promise<unknown>
  lrange(k: string, a: number, b: number): Promise<string[]>
  rpush(k: string, v: string): Promise<number>
  expire(k: string, s: number): Promise<unknown>
  llen(k: string): Promise<number>
}

function redis(): RedisLike | null {
  if (forcedMode && forcedMode !== 'redis') return null
  try {
    return (getApp()?.redis as RedisLike | undefined) ?? null
  } catch {
    return null
  }
}

export async function runStoreMode(): Promise<RunStoreMode> {
  if (await hasTables()) return 'db'
  return redis() ? 'redis' : 'memory'
}

/** Tests only: pin the backing and forget the table probe. */
export function _setRunStoreForTests(mode: RunStoreMode | null): void {
  forcedMode = mode
  tableSeen = null
  memRuns.clear()
  memEvents.clear()
}

// ─── Memory backing ───────────────────────────────────────────────────────────

const memRuns = new Map<string, ChaosRun>()
const memEvents = new Map<string, ChaosRunEvent[]>()

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null || raw === '') return fallback
  if (typeof raw !== 'string') return raw as T
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

const iso = (v: unknown): string | null => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function fromRow(r: Record<string, unknown>): ChaosRun {
  return {
    id: String(r.id).toLowerCase(),
    kind: (r.kind as RunKind) ?? 'drill',
    status: (r.status as RunStatus) ?? 'planned',
    fault_key: (r.fault_key as string) ?? null,
    label: String(r.label ?? r.fault_key ?? 'run'),
    target: parseJson<FaultTarget | null>(r.target, null),
    params: parseJson<FaultParams>(r.params, {}),
    hypothesis: parseJson<HypothesisRule[]>(r.hypothesis, []),
    verdict: (r.verdict as Verdict) ?? null,
    verdict_detail: parseJson<Record<string, unknown> | null>(r.verdict_detail, null),
    baseline: parseJson<Record<string, unknown> | null>(r.baseline, null),
    started_by: r.started_by ? String(r.started_by).toLowerCase() : null,
    started_at: iso(r.started_at),
    ends_at: iso(r.ends_at),
    ended_at: iso(r.ended_at),
    preset_id: (r.preset_id as string) ?? null,
    gameday_id: (r.gameday_id as string) ?? null,
    meta: parseJson<Record<string, unknown>>(r.meta, {}),
    created_at: iso(r.created_at) ?? new Date().toISOString()
  }
}

function toRow(run: ChaosRun): Record<string, unknown> {
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    fault_key: run.fault_key,
    label: run.label.slice(0, 200),
    target: run.target ? JSON.stringify(run.target) : null,
    params: JSON.stringify(run.params ?? {}),
    hypothesis: JSON.stringify(run.hypothesis ?? []),
    verdict: run.verdict,
    verdict_detail: run.verdict_detail ? JSON.stringify(run.verdict_detail) : null,
    baseline: run.baseline ? JSON.stringify(run.baseline) : null,
    started_by: run.started_by,
    started_at: run.started_at ? new Date(run.started_at) : null,
    ends_at: run.ends_at ? new Date(run.ends_at) : null,
    ended_at: run.ended_at ? new Date(run.ended_at) : null,
    preset_id: run.preset_id,
    gameday_id: run.gameday_id,
    meta: JSON.stringify(run.meta ?? {}),
    created_at: new Date(run.created_at)
  }
}

function patchRow(patch: Partial<ChaosRun>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id' || k === 'created_at') continue
    if (['target', 'params', 'hypothesis', 'verdict_detail', 'baseline', 'meta'].includes(k))
      out[k] = v == null ? null : JSON.stringify(v)
    else if (['started_at', 'ends_at', 'ended_at'].includes(k))
      out[k] = v == null ? null : new Date(String(v))
    else out[k] = v
  }
  return out
}

// ─── Runs ─────────────────────────────────────────────────────────────────────

export type NewRun = Partial<Omit<ChaosRun, 'id' | 'created_at'>> & { kind: RunKind; label: string }

export async function createRun(input: NewRun): Promise<ChaosRun> {
  const run: ChaosRun = {
    id: randomUUID(),
    kind: input.kind,
    status: input.status ?? 'planned',
    fault_key: input.fault_key ?? null,
    label: input.label,
    target: input.target ?? null,
    params: input.params ?? {},
    hypothesis: input.hypothesis ?? [],
    verdict: input.verdict ?? null,
    verdict_detail: input.verdict_detail ?? null,
    baseline: input.baseline ?? null,
    started_by: input.started_by ?? null,
    started_at: input.started_at ?? null,
    ends_at: input.ends_at ?? null,
    ended_at: input.ended_at ?? null,
    preset_id: input.preset_id ?? null,
    gameday_id: input.gameday_id ?? null,
    meta: input.meta ?? {},
    created_at: new Date().toISOString()
  }
  if (await hasTables()) {
    try {
      await db(RUNS_TABLE).insert(toRow(run))
      return run
    } catch {
      /* fall through to the next backing */
    }
  }
  const r = redis()
  if (r) {
    try {
      await r.set(`${RUN_KEY}${run.id}`, JSON.stringify(run), 'EX', RUN_TTL_S)
      await r.lpush(RUNS_LIST, run.id)
      await r.ltrim(RUNS_LIST, 0, RUNS_KEEP - 1)
      return run
    } catch {
      /* memory */
    }
  }
  memRuns.set(run.id, run)
  if (memRuns.size > RUNS_KEEP) memRuns.delete(memRuns.keys().next().value as string)
  return run
}

export async function getRun(id: string): Promise<ChaosRun | null> {
  const key = String(id).toLowerCase()
  if (await hasTables()) {
    try {
      const row = (await db(RUNS_TABLE).where({ id: key }).first()) as
        | Record<string, unknown>
        | undefined
      if (row) return fromRow(row)
    } catch {
      /* next backing */
    }
  }
  const r = redis()
  if (r) {
    try {
      const raw = await r.get(`${RUN_KEY}${key}`)
      if (raw) return JSON.parse(raw) as ChaosRun
    } catch {
      /* memory */
    }
  }
  return memRuns.get(key) ?? null
}

/**
 * Patch a run. `ifStatus` makes the write conditional (an origin node finishing a run that
 * another node already aborted leaves the abort in place). Returns the stored run or null.
 */
export async function updateRun(
  id: string,
  patch: Partial<ChaosRun>,
  opts: { ifStatus?: RunStatus[] } = {}
): Promise<ChaosRun | null> {
  const key = String(id).toLowerCase()
  if (await hasTables()) {
    try {
      let q = db(RUNS_TABLE).where({ id: key })
      if (opts.ifStatus) q = q.whereIn('status', opts.ifStatus)
      const n = await q.update(patchRow(patch))
      if (!n) return null
      return await getRun(key)
    } catch {
      /* next backing */
    }
  }
  const current = await getRun(key)
  if (!current) return null
  if (opts.ifStatus && !opts.ifStatus.includes(current.status)) return null
  const next: ChaosRun = { ...current, ...patch, id: current.id, created_at: current.created_at }
  const r = redis()
  if (r) {
    try {
      await r.set(`${RUN_KEY}${key}`, JSON.stringify(next), 'EX', RUN_TTL_S)
      return next
    } catch {
      /* memory */
    }
  }
  memRuns.set(key, next)
  return next
}

export interface ListRunsOptions {
  limit?: number
  status?: RunStatus | RunStatus[]
  kind?: RunKind
  fault_key?: string
}

export async function listRuns(opts: ListRunsOptions = {}): Promise<ChaosRun[]> {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 50))
  const statuses = opts.status ? (Array.isArray(opts.status) ? opts.status : [opts.status]) : null
  const keep = (run: ChaosRun) =>
    (!statuses || statuses.includes(run.status)) &&
    (!opts.kind || run.kind === opts.kind) &&
    (!opts.fault_key || run.fault_key === opts.fault_key)
  if (await hasTables()) {
    try {
      // `id` breaks created_at ties deterministically (datetime resolution is ~3 ms on MSSQL).
      let q = db(RUNS_TABLE).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit)
      if (statuses) q = q.whereIn('status', statuses)
      if (opts.kind) q = q.where({ kind: opts.kind })
      if (opts.fault_key) q = q.where({ fault_key: opts.fault_key })
      const rows = (await q) as Record<string, unknown>[]
      return rows.map(fromRow)
    } catch {
      /* next backing */
    }
  }
  const r = redis()
  if (r) {
    try {
      const ids = await r.lrange(RUNS_LIST, 0, RUNS_KEEP - 1)
      const out: ChaosRun[] = []
      for (const id of ids) {
        const raw = await r.get(`${RUN_KEY}${id}`)
        if (!raw) continue
        const run = JSON.parse(raw) as ChaosRun
        if (keep(run)) out.push(run)
        if (out.length >= limit) break
      }
      return out
    } catch {
      /* memory */
    }
  }
  // Newest first; insertion order breaks ties made inside one millisecond.
  return [...memRuns.values()]
    .map((run, i) => ({ run, i }))
    .filter((x) => keep(x.run))
    .sort((a, b) => b.run.created_at.localeCompare(a.run.created_at) || b.i - a.i)
    .map((x) => x.run)
    .slice(0, limit)
}

/** The newest finished-or-running run per fault key (the catalog cards' "last run"). */
export async function lastRunPerFault(): Promise<Map<string, ChaosRun>> {
  const out = new Map<string, ChaosRun>()
  for (const run of await listRuns({ limit: 300 })) {
    if (!run.fault_key || run.status === 'refused' || run.status === 'planned') continue
    if (!out.has(run.fault_key)) out.set(run.fault_key, run)
  }
  return out
}

// ─── Events ───────────────────────────────────────────────────────────────────

export async function appendRunEvent(
  runId: string,
  kind: RunEventKind,
  data: Record<string, unknown> = {},
  actor: string | null = null
): Promise<ChaosRunEvent | null> {
  const run_id = String(runId).toLowerCase()
  const at = new Date().toISOString()
  if (await hasTables()) {
    try {
      const inserted = (await db(EVENTS_TABLE)
        .insert({ run_id, at: new Date(at), kind, actor, data: JSON.stringify(data) })
        .returning('id')) as Array<{ id: number } | number>
      const first = inserted?.[0]
      const id = typeof first === 'object' && first ? Number(first.id) : Number(first) || 0
      return { id, run_id, at, kind, actor, data }
    } catch {
      /* next backing */
    }
  }
  const r = redis()
  if (r) {
    try {
      const k = `${RUN_KEY}${run_id}:events`
      // The id rides inside the JSON (the list index shifts once the list is trimmed).
      const ev: ChaosRunEvent = { id: (await r.llen(k)) + 1, run_id, at, kind, actor, data }
      const n = await r.rpush(k, JSON.stringify(ev))
      await r.expire(k, RUN_TTL_S)
      if (n > EVENTS_KEEP) await r.ltrim(k, n - EVENTS_KEEP, -1)
      return ev
    } catch {
      /* memory */
    }
  }
  const list = memEvents.get(run_id) ?? []
  const ev: ChaosRunEvent = { id: list.length + 1, run_id, at, kind, actor, data }
  list.push(ev)
  if (list.length > EVENTS_KEEP) list.splice(0, list.length - EVENTS_KEEP)
  memEvents.set(run_id, list)
  return ev
}

/** A run's events in order; `after` = the last event id the caller has (cockpit polling). */
export async function listRunEvents(
  runId: string,
  opts: { after?: number; limit?: number; kinds?: RunEventKind[] } = {}
): Promise<ChaosRunEvent[]> {
  const run_id = String(runId).toLowerCase()
  const limit = Math.min(EVENTS_KEEP, Math.max(1, opts.limit ?? 1000))
  const after = opts.after ?? 0
  const keep = (e: ChaosRunEvent) => e.id > after && (!opts.kinds || opts.kinds.includes(e.kind))
  if (await hasTables()) {
    try {
      let q = db(EVENTS_TABLE)
        .where({ run_id })
        .where('id', '>', after)
        .orderBy('id', 'asc')
        .limit(limit)
      if (opts.kinds) q = q.whereIn('kind', opts.kinds)
      const rows = (await q) as Record<string, unknown>[]
      return rows.map((r) => ({
        id: Number(r.id),
        run_id,
        at: iso(r.at) ?? '',
        kind: r.kind as RunEventKind,
        actor: r.actor ? String(r.actor).toLowerCase() : null,
        data: parseJson<Record<string, unknown>>(r.data, {})
      }))
    } catch {
      /* next backing */
    }
  }
  const r = redis()
  if (r) {
    try {
      const raws = await r.lrange(`${RUN_KEY}${run_id}:events`, 0, -1)
      const out: ChaosRunEvent[] = []
      for (const raw of raws) {
        const ev = JSON.parse(raw) as ChaosRunEvent
        if (keep(ev)) out.push(ev)
        if (out.length >= limit) break
      }
      return out
    } catch {
      /* memory */
    }
  }
  return (memEvents.get(run_id) ?? []).filter(keep).slice(0, limit)
}
