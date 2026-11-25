import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { parseJson } from '../../pipeline-engine.js'
import {
  type DataRun,
  type DataRunKind,
  type DataRunStatus,
  type DataStep,
  type DataStepState,
  OPEN_DATA_STATUSES
} from './types.js'

/**
 * The rows of nivaro_hub_data_runs: one per backup, files backup, recorded sighting, drill,
 * refresh, refresh rollback and rehearsal. A running run writes `heartbeat_at` every
 * HEARTBEAT_MS; a run whose heartbeat is older than STALE_MS has lost its process (healRuns).
 *
 * `keep_secret` (a refresh's sealed keep set) is never read out here: a run answers only whether
 * it still holds one.
 */

const RUNS = 'nivaro_hub_data_runs'
export const HEARTBEAT_MS = 30_000
export const STALE_MS = 3 * 60_000
const ERROR_MAX = 1000

function iso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function obj(v: unknown): Record<string, unknown> | null {
  const p = typeof v === 'string' ? parseJson(v) : v
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null
}

export function runFromRow(r: Record<string, unknown>): DataRun {
  const steps = typeof r.steps === 'string' ? parseJson(r.steps) : r.steps
  return {
    id: Number(r.id),
    kind: String(r.kind) as DataRunKind,
    environment_id: Number(r.environment_id),
    source_environment_id: r.source_environment_id == null ? null : Number(r.source_environment_id),
    status: String(r.status) as DataRunStatus,
    step: (r.step as string | null) ?? null,
    started_via: r.started_via === 'schedule' ? 'schedule' : 'person',
    steps: Array.isArray(steps) ? (steps as DataStep[]) : [],
    plan: obj(r.plan),
    plan_hash: (r.plan_hash as string | null) ?? null,
    result: obj(r.result),
    artifact: obj(r.artifact),
    error: (r.error as string | null) ?? null,
    started_by: (r.started_by as string | null) ?? null,
    started_at: iso(r.started_at),
    finished_at: iso(r.finished_at),
    heartbeat_at: iso(r.heartbeat_at),
    expires_at: iso(r.expires_at),
    holds_keep_set: !!r.keep_secret
  }
}

export function newSteps(defs: ReadonlyArray<{ key: string; label: string }>): DataStep[] {
  return defs.map((d) => ({
    key: d.key,
    label: d.label,
    state: 'pending' as DataStepState,
    started_at: null,
    ms: null,
    note: null
  }))
}

const uuidOrNull = (v: string | null | undefined) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : null)

export async function createRun(o: {
  kind: DataRunKind
  environmentId: number
  sourceEnvironmentId?: number | null
  steps: DataStep[]
  plan?: Record<string, unknown> | null
  planHash?: string | null
  startedBy?: string | null
  via?: 'person' | 'schedule'
  status?: DataRunStatus
  result?: Record<string, unknown> | null
}): Promise<number> {
  const now = new Date()
  const id = await insertReturningId(db, RUNS, {
    kind: o.kind,
    environment_id: o.environmentId,
    source_environment_id: o.sourceEnvironmentId ?? null,
    status: o.status ?? 'running',
    step: null,
    started_via: o.via ?? 'person',
    steps: JSON.stringify(o.steps),
    plan: o.plan ? JSON.stringify(o.plan) : null,
    plan_hash: o.planHash ?? null,
    result: o.result ? JSON.stringify(o.result) : null,
    started_by: uuidOrNull(o.startedBy),
    started_at: now,
    heartbeat_at: now,
    finished_at: o.status && !OPEN_DATA_STATUSES.includes(o.status) ? now : null
  })
  return Number(id)
}

export async function readRun(id: number): Promise<DataRun | null> {
  if (!Number.isSafeInteger(id) || id < 1) return null
  const r = (await db(RUNS).where({ id }).first()) as Record<string, unknown> | undefined
  return r ? runFromRow(r) : null
}

export async function listRuns(o: {
  environmentId?: number
  kinds?: DataRunKind[]
  limit?: number
}): Promise<DataRun[]> {
  const q = db(RUNS)
    .select(
      'id',
      'kind',
      'environment_id',
      'source_environment_id',
      'status',
      'step',
      'started_via',
      'steps',
      'plan',
      'plan_hash',
      'result',
      'artifact',
      'error',
      'started_by',
      'started_at',
      'finished_at',
      'heartbeat_at',
      'expires_at',
      db.raw('CASE WHEN keep_secret IS NULL THEN 0 ELSE 1 END AS keep_secret')
    )
    .orderBy('id', 'desc')
    .limit(Math.min(Math.max(o.limit ?? 50, 1), 500))
  if (o.environmentId !== undefined) q.where({ environment_id: o.environmentId })
  if (o.kinds?.length) q.whereIn('kind', o.kinds)
  const rows = (await q) as Record<string, unknown>[]
  return rows.map((r) =>
    runFromRow({ ...r, keep_secret: Number(r.keep_secret) === 1 ? 'x' : null })
  )
}

/** The newest run of each kind for an environment (finished or not). */
export async function latestRuns(envId: number): Promise<Partial<Record<DataRunKind, DataRun>>> {
  const out: Partial<Record<DataRunKind, DataRun>> = {}
  for (const r of await listRuns({ environmentId: envId, limit: 200 })) {
    if (!out[r.kind]) out[r.kind] = r
  }
  return out
}

/** The newest finished `done` run of a kind, or null. */
export async function lastDone(envId: number, kind: DataRunKind): Promise<DataRun | null> {
  const r = (await db(RUNS)
    .where({ environment_id: envId, kind, status: 'done' })
    .orderBy('id', 'desc')
    .first()) as Record<string, unknown> | undefined
  return r ? runFromRow(r) : null
}

/** The newest run of a kind (any status), for the scheduler's "is it due". */
export async function lastStarted(envId: number, kind: DataRunKind): Promise<Date | null> {
  const r = (await db(RUNS)
    .where({ environment_id: envId, kind })
    .orderBy('id', 'desc')
    .first('started_at')) as { started_at: unknown } | undefined
  const s = iso(r?.started_at)
  return s ? new Date(s) : null
}

/** An open run (running / waiting / interrupted) of the environment, oldest first. */
export async function openRunFor(envId: number): Promise<DataRun | null> {
  const r = (await db(RUNS)
    .where((q) => q.where({ environment_id: envId }).orWhere({ source_environment_id: envId }))
    .whereIn('status', [...OPEN_DATA_STATUSES])
    .orderBy('id', 'asc')
    .first()) as Record<string, unknown> | undefined
  return r ? runFromRow(r) : null
}

export interface RunPatch {
  status?: DataRunStatus
  step?: string | null
  steps?: DataStep[]
  result?: Record<string, unknown> | null
  artifact?: Record<string, unknown> | null
  error?: string | null
  expiresAt?: Date | null
  keepSecret?: string | null
  finished?: boolean
}

export async function patchRun(id: number, p: RunPatch): Promise<void> {
  const cols: Record<string, unknown> = { heartbeat_at: new Date() }
  if (p.status !== undefined) cols.status = p.status
  if (p.step !== undefined) cols.step = p.step
  if (p.steps !== undefined) cols.steps = JSON.stringify(p.steps)
  if (p.result !== undefined) cols.result = p.result === null ? null : JSON.stringify(p.result)
  if (p.artifact !== undefined)
    cols.artifact = p.artifact === null ? null : JSON.stringify(p.artifact)
  if (p.error !== undefined) cols.error = p.error === null ? null : p.error.slice(0, ERROR_MAX)
  if (p.expiresAt !== undefined) cols.expires_at = p.expiresAt
  if (p.keepSecret !== undefined) cols.keep_secret = p.keepSecret
  if (p.finished) cols.finished_at = new Date()
  await db(RUNS).where({ id }).update(cols)
}

export async function heartbeat(id: number): Promise<void> {
  await db(RUNS).where({ id }).update({ heartbeat_at: new Date() })
}

/** The sealed keep set of a refresh (opened by refresh.ts only). */
export async function readKeepSecret(id: number): Promise<string | null> {
  const r = (await db(RUNS).where({ id }).first('keep_secret')) as
    | { keep_secret: string | null }
    | undefined
  return r?.keep_secret ?? null
}

/** Running runs whose heartbeat is older than STALE_MS (their process went away). */
export async function staleRuns(now = new Date()): Promise<DataRun[]> {
  const before = new Date(now.getTime() - STALE_MS)
  const rows = (await db(RUNS)
    .where({ status: 'running' })
    .where((q) => q.where('heartbeat_at', '<', before).orWhereNull('heartbeat_at'))
    .select('*')) as Record<string, unknown>[]
  return rows.map(runFromRow)
}

/** Refreshes whose rollback window ended while they still hold a keep set or rollback file. */
export async function expiredRollbacks(now = new Date()): Promise<DataRun[]> {
  const rows = (await db(RUNS)
    .where({ kind: 'refresh' })
    .whereNotNull('expires_at')
    .where('expires_at', '<', now)
    .whereNotIn('status', [...OPEN_DATA_STATUSES])
    .select('*')) as Record<string, unknown>[]
  return rows.map(runFromRow)
}

/** Backup runs whose artifact still exists, oldest first (retention). */
export async function keptArtifacts(envId: number, kind: DataRunKind): Promise<DataRun[]> {
  const rows = (await db(RUNS)
    .where({ environment_id: envId, kind, status: 'done' })
    .whereNotNull('artifact')
    .orderBy('id', 'asc')
    .select('*')) as Record<string, unknown>[]
  return rows.map(runFromRow).filter((r) => r.artifact && r.artifact.deleted_at == null)
}

/** Sets one step's state (and the run's current step) on a copy of the list. */
export function setStep(
  steps: DataStep[],
  key: string,
  state: DataStepState,
  note?: string | null,
  now = Date.now()
): DataStep[] {
  return steps.map((s) => {
    if (s.key !== key) return s
    const started = s.started_at ? Date.parse(s.started_at) : now
    return {
      ...s,
      state,
      started_at: s.started_at ?? new Date(now).toISOString(),
      ms: state === 'running' ? null : Math.max(0, now - started),
      note: note === undefined ? s.note : note
    }
  })
}
