import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import type { StackRoleName } from '../docker/agent-types.js'
import { type AutoRule, type AutoState, EMPTY_STATE, parseRule, parseState } from './rules.js'
import { isRoleName, type RoleFigures, roleScaleOf, type ScaleShape } from './shape.js'

/**
 * Nivaro Hub scaling: the two tables of migration 581. `nivaro_hub_scale_roles` keeps, per stack
 * and role, the numbers the renderers lay over the size template, the "pin manual" switch and
 * the autoscaling rule + state; `nivaro_hub_scale_runs` is the log of every change (and every
 * automatic decision that could not run). Reads tolerate a database behind 581 (no table = no
 * shape, no runs), so a renderer on an older ledger renders the template as before.
 */

export const SCALE_ROLES = 'nivaro_hub_scale_roles'
export const SCALE_RUNS = 'nivaro_hub_scale_runs'

export type TargetKind = 'environment' | 'shared'
export const isTargetKind = (v: unknown): v is TargetKind => v === 'environment' || v === 'shared'

export type RunSource = 'manual' | 'auto' | 'schedule'
export type RunStatus = 'running' | 'success' | 'failed' | 'cancelled' | 'skipped' | 'interrupted'

export interface RoleRow {
  role: StackRoleName
  replicas: number | null
  cpus: number | null
  memory_mb: number | null
  pinned: boolean
  auto: AutoRule | null
  state: AutoState
  updated_at: string | null
}

export interface ScaleStep {
  to: RoleFigures[]
  status: 'pending' | 'applying' | 'done' | 'failed'
  spec_hash?: string | null
  at?: string | null
}

export interface ScaleRun {
  id: number
  target_kind: TargetKind
  target_id: number
  stack: string | null
  source: RunSource
  status: RunStatus
  reason: string | null
  figures: Record<string, unknown> | null
  from: RoleFigures[]
  to: RoleFigures[]
  steps: ScaleStep[]
  step_index: number
  spec_hash: string | null
  plan_hash: string | null
  error_code: string | null
  error: string | null
  started_by: string | null
  created_at: string | null
  finished_at: string | null
  heartbeat_at: string | null
}

async function hasTable(name: string): Promise<boolean> {
  try {
    return await db.schema.hasTable(name)
  } catch {
    return false
  }
}

function json<T>(raw: unknown, dflt: T): T {
  if (raw == null || raw === '') return dflt
  if (typeof raw !== 'string') return raw as T
  try {
    return JSON.parse(raw) as T
  } catch {
    return dflt
  }
}

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null
  // SQLite keeps a dateTime as epoch milliseconds.
  const t =
    v instanceof Date
      ? v.getTime()
      : typeof v === 'number' || /^\d{12,}$/.test(String(v))
        ? Number(v)
        : Date.parse(String(v))
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}
const numOrNull = (v: unknown): number | null =>
  v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v)
const truthy = (v: unknown) => v === true || v === 1 || v === '1'

function figuresList(raw: unknown): RoleFigures[] {
  const v = json<unknown>(raw, [])
  if (!Array.isArray(v)) return []
  const out: RoleFigures[] = []
  for (const r of v) {
    if (!r || typeof r !== 'object' || !isRoleName((r as { role?: unknown }).role)) continue
    const x = r as Record<string, unknown>
    out.push({
      role: x.role as StackRoleName,
      replicas: Number(x.replicas) || 0,
      cpus: numOrNull(x.cpus),
      memory_mb: numOrNull(x.memory_mb)
    })
  }
  return out
}

function roleRowOf(r: Record<string, unknown>): RoleRow | null {
  if (!isRoleName(r.role)) return null
  const role = r.role
  return {
    role,
    replicas: numOrNull(r.replicas),
    cpus: numOrNull(r.cpus),
    memory_mb: numOrNull(r.memory_mb),
    pinned: truthy(r.pinned),
    auto: r.auto == null ? null : parseRule(r.auto, role),
    state: parseState(r.state),
    updated_at: iso(r.updated_at)
  }
}

/** Every role row of a stack (no table = none). */
export async function readRoles(kind: TargetKind, id: number): Promise<RoleRow[]> {
  if (!(await hasTable(SCALE_ROLES))) return []
  const rows = (await db(SCALE_ROLES)
    .where({ target_kind: kind, target_id: id })
    .orderBy('id', 'asc')
    .select('*')) as Array<Record<string, unknown>>
  return rows.map(roleRowOf).filter((r): r is RoleRow => r !== null)
}

/**
 * The shape the renderers lay over the size template for this stack; null when none is kept
 * (or the database is behind migration 581).
 */
export async function readScaleShape(kind: TargetKind, id: number): Promise<ScaleShape | null> {
  const rows = await readRoles(kind, id)
  const shape: ScaleShape = {}
  for (const r of rows) {
    const s = roleScaleOf(r)
    if (Object.keys(s).length) shape[r.role] = s
  }
  return Object.keys(shape).length ? shape : null
}

/** The shape a run's `to` (or `from`) list stands for: every role's numbers as listed. */
export function shapeFromFigures(list: readonly RoleFigures[]): ScaleShape {
  const shape: ScaleShape = {}
  for (const f of list)
    shape[f.role] = roleScaleOf({
      replicas: f.replicas,
      cpus: f.cpus ?? undefined,
      memory_mb: f.memory_mb ?? undefined
    })
  return shape
}

async function upsert(
  kind: TargetKind,
  id: number,
  role: StackRoleName,
  patch: Record<string, unknown>
): Promise<void> {
  const where = { target_kind: kind, target_id: id, role }
  const n = await db(SCALE_ROLES)
    .where(where)
    .update({ ...patch, updated_at: new Date() })
  if (Number(n) > 0) return
  try {
    await db(SCALE_ROLES).insert({ ...where, pinned: false, ...patch, updated_at: new Date() })
  } catch {
    // A row inserted meanwhile (the unique index): write onto it.
    await db(SCALE_ROLES)
      .where(where)
      .update({ ...patch, updated_at: new Date() })
  }
}

/** Keeps these roles' numbers (what the stack now runs); other roles stay as they are. */
export async function writeShape(
  kind: TargetKind,
  id: number,
  list: readonly RoleFigures[],
  by: string | null
): Promise<void> {
  for (const f of list)
    await upsert(kind, id, f.role, {
      replicas: f.replicas,
      cpus: f.cpus,
      memory_mb: f.memory_mb,
      updated_by: by
    })
}

export async function setPinned(
  kind: TargetKind,
  id: number,
  role: StackRoleName,
  pinned: boolean,
  by: string
): Promise<void> {
  await upsert(kind, id, role, { pinned, updated_by: by })
}

export async function setRule(
  kind: TargetKind,
  id: number,
  role: StackRoleName,
  rule: AutoRule | null,
  by: string
): Promise<void> {
  // A new rule starts counting afresh; the last change (its cooldown), the last at-max notice
  // and a pause it put itself in stay (Resume rule lifts a pause, never an edit).
  const cur = (await readRoles(kind, id)).find((r) => r.role === role)?.state ?? EMPTY_STATE
  const state: AutoState = {
    ...EMPTY_STATE,
    max_hits: [],
    last_change_at: cur.last_change_at,
    max_noticed_at: cur.max_noticed_at,
    paused_at: cur.paused_at,
    paused_reason: cur.paused_reason,
    resumed_at: cur.resumed_at
  }
  await upsert(kind, id, role, {
    auto: rule ? JSON.stringify(rule) : null,
    state: JSON.stringify(state),
    updated_by: by
  })
}

/** Lifts a rule's own pause: failures before now no longer count. */
export async function resumeRule(
  kind: TargetKind,
  id: number,
  role: StackRoleName,
  by: string,
  at = new Date()
): Promise<void> {
  const cur = (await readRoles(kind, id)).find((r) => r.role === role)?.state ?? EMPTY_STATE
  await upsert(kind, id, role, {
    state: JSON.stringify({
      ...cur,
      above: 0,
      below: 0,
      paused_at: null,
      paused_reason: null,
      resumed_at: at.toISOString()
    }),
    updated_by: by
  })
}

export async function saveState(
  kind: TargetKind,
  id: number,
  role: StackRoleName,
  state: AutoState
): Promise<void> {
  await db(SCALE_ROLES)
    .where({ target_kind: kind, target_id: id, role })
    .update({ state: JSON.stringify(state) })
}

/** Notes a change on every role it touched, so each rule's cooldown starts from it. */
export async function noteChange(
  kind: TargetKind,
  id: number,
  roles: readonly StackRoleName[],
  at: Date
): Promise<void> {
  for (const role of roles) {
    const cur = (await readRoles(kind, id)).find((r) => r.role === role)
    if (!cur) continue
    await saveState(kind, id, role, {
      ...cur.state,
      above: 0,
      below: 0,
      last_change_at: at.toISOString()
    })
  }
}

// ── runs ─────────────────────────────────────────────────────────────────────────────────────

export function runFromRow(r: Record<string, unknown>): ScaleRun {
  return {
    id: Number(r.id),
    target_kind: r.target_kind === 'shared' ? 'shared' : 'environment',
    target_id: Number(r.target_id),
    stack: r.stack == null ? null : String(r.stack),
    source: (['manual', 'auto', 'schedule'].includes(String(r.source))
      ? r.source
      : 'manual') as RunSource,
    status: String(r.status) as RunStatus,
    reason: r.reason == null ? null : String(r.reason),
    figures: json<Record<string, unknown> | null>(r.figures, null),
    from: figuresList(r.from_shape),
    to: figuresList(r.to_shape),
    steps: (json<unknown>(r.steps, []) as ScaleStep[]).map((s) => ({
      ...s,
      to: figuresList(s?.to)
    })),
    step_index: Number(r.step_index ?? 0),
    spec_hash: r.spec_hash == null ? null : String(r.spec_hash),
    plan_hash: r.plan_hash == null ? null : String(r.plan_hash),
    error_code: r.error_code == null ? null : String(r.error_code),
    error: r.error == null ? null : String(r.error),
    started_by: r.started_by == null ? null : String(r.started_by),
    created_at: iso(r.created_at),
    finished_at: iso(r.finished_at),
    heartbeat_at: iso(r.heartbeat_at)
  }
}

export interface NewRun {
  target_kind: TargetKind
  target_id: number
  stack: string | null
  source: RunSource
  status: RunStatus
  reason: string
  figures: Record<string, unknown> | null
  from: RoleFigures[]
  to: RoleFigures[]
  steps: ScaleStep[]
  plan_hash: string | null
  started_by: string | null
  error_code?: string | null
  error?: string | null
  /** When it happened (default now). */
  at?: Date
}

const cut = (s: string | null | undefined, n: number) => (s == null ? null : String(s).slice(0, n))

export async function insertRun(r: NewRun): Promise<number> {
  const now = r.at ?? new Date()
  const row = {
    target_kind: r.target_kind,
    target_id: r.target_id,
    stack: cut(r.stack, 64),
    source: r.source,
    status: r.status,
    reason: cut(r.reason, 500),
    figures: r.figures ? JSON.stringify(r.figures) : null,
    from_shape: JSON.stringify(r.from),
    to_shape: JSON.stringify(r.to),
    steps: JSON.stringify(r.steps),
    step_index: 0,
    plan_hash: r.plan_hash,
    started_by: r.started_by,
    error_code: cut(r.error_code ?? null, 64),
    error: cut(r.error ?? null, 1000),
    created_at: now,
    heartbeat_at: r.status === 'running' ? now : null,
    finished_at: r.status === 'running' ? null : now
  }
  return Number(await insertReturningId(db, SCALE_RUNS, row))
}

export async function readRun(id: number): Promise<ScaleRun | null> {
  if (!(await hasTable(SCALE_RUNS))) return null
  const r = (await db(SCALE_RUNS).where({ id }).first()) as Record<string, unknown> | undefined
  return r ? runFromRow(r) : null
}

export async function listRuns(
  kind: TargetKind | null,
  id: number | null,
  limit = 30
): Promise<ScaleRun[]> {
  if (!(await hasTable(SCALE_RUNS))) return []
  const q = db(SCALE_RUNS)
    .orderBy('id', 'desc')
    .limit(Math.min(Math.max(limit, 1), 200))
  if (kind && id != null) q.where({ target_kind: kind, target_id: id })
  return ((await q.select('*')) as Array<Record<string, unknown>>).map(runFromRow)
}

/** The run of this stack still `running`, if any. */
export async function openRunOf(kind: TargetKind, id: number): Promise<ScaleRun | null> {
  if (!(await hasTable(SCALE_RUNS))) return null
  const r = (await db(SCALE_RUNS)
    .where({ target_kind: kind, target_id: id, status: 'running' })
    .orderBy('id', 'asc')
    .first()) as Record<string, unknown> | undefined
  return r ? runFromRow(r) : null
}

/** Runs still `running` whose heartbeat is older than `before` (their process stopped). */
export async function staleRuns(before: Date): Promise<ScaleRun[]> {
  if (!(await hasTable(SCALE_RUNS))) return []
  const rows = (await db(SCALE_RUNS)
    .where({ status: 'running' })
    .where((q) => q.whereNull('heartbeat_at').orWhere('heartbeat_at', '<', before))
    .orderBy('id', 'asc')
    .limit(50)
    .select('*')) as Array<Record<string, unknown>>
  return rows.map(runFromRow)
}

/** A conditional write: only while the run is still `running` (true = it was). */
export async function updateRunning(id: number, patch: Record<string, unknown>): Promise<boolean> {
  const out: Record<string, unknown> = { ...patch }
  for (const k of ['steps', 'figures'] as const)
    if (out[k] !== undefined && typeof out[k] !== 'string') out[k] = JSON.stringify(out[k])
  if (typeof out.error === 'string') out.error = (out.error as string).slice(0, 1000)
  const n = await db(SCALE_RUNS).where({ id, status: 'running' }).update(out)
  return Number(n) > 0
}

/** The newest skipped row of this stack + role + code (automatic decisions are logged ≤ 1/30 min). */
export async function lastSkipped(
  kind: TargetKind,
  id: number,
  code: string
): Promise<Date | null> {
  if (!(await hasTable(SCALE_RUNS))) return null
  const r = (await db(SCALE_RUNS)
    .where({ target_kind: kind, target_id: id, status: 'skipped', error_code: code })
    .orderBy('id', 'desc')
    .first('created_at')) as { created_at: unknown } | undefined
  const t = iso(r?.created_at)
  return t ? new Date(t) : null
}

/**
 * The spec hash of the newest successful scale of this environment's stack started after `since`
 * (a deploy's start): what swarm runs after that deploy was scaled. null when none.
 */
export async function scaledSpecHashSince(
  envId: number,
  stack: string,
  since: unknown
): Promise<string | null> {
  if (!(await hasTable(SCALE_RUNS))) return null
  const q = db(SCALE_RUNS)
    // A run's spec_hash is set only once the Hub knows swarm runs it: a success, or a failed run
    // whose change the agent applied and the Hub adopted from the live stack (reconcile.ts).
    .where({ target_kind: 'environment', target_id: envId, stack })
    .whereNotNull('spec_hash')
    .orderBy('id', 'desc')
  const at = iso(since)
  if (at) q.where('created_at', '>', new Date(at))
  const r = (await q.first('spec_hash')) as { spec_hash: string | null } | undefined
  return r?.spec_hash && /^[0-9a-f]{64}$/.test(r.spec_hash) ? r.spec_hash : null
}

/**
 * Single-flight resume: one caller (holding the stack's lock) claims a stale run by moving its
 * heartbeat on, only while it is still the stale value it read. true = this caller resumes it.
 */
export async function claimStaleRun(id: number, before: Date, at: Date): Promise<boolean> {
  const n = await db(SCALE_RUNS)
    .where({ id, status: 'running' })
    .where((q) => q.whereNull('heartbeat_at').orWhere('heartbeat_at', '<', before))
    .update({ heartbeat_at: at })
  return Number(n) > 0
}

/** Writes a field on a run whatever its status (an adoption after the run ended). */
export async function updateRun(id: number, patch: Record<string, unknown>): Promise<void> {
  const out: Record<string, unknown> = { ...patch }
  for (const k of ['steps', 'figures'] as const)
    if (out[k] !== undefined && typeof out[k] !== 'string') out[k] = JSON.stringify(out[k])
  await db(SCALE_RUNS).where({ id }).update(out)
}

/**
 * The automatic runs (auto / schedule, never skipped rows) of a stack since `since`, newest
 * first: how many failed in a row and when the newest of those ended.
 */
export async function autoFailures(
  kind: TargetKind,
  id: number,
  since: string | null
): Promise<{ count: number; code: string | null; last_at: string | null }> {
  if (!(await hasTable(SCALE_RUNS))) return { count: 0, code: null, last_at: null }
  const q = db(SCALE_RUNS)
    .where({ target_kind: kind, target_id: id })
    .whereIn('source', ['auto', 'schedule'])
    .whereNot({ status: 'skipped' })
    .orderBy('id', 'desc')
    .limit(10)
  if (since) q.where('created_at', '>', new Date(since))
  const rows = (await q.select('status', 'error_code', 'finished_at', 'created_at')) as Array<
    Record<string, unknown>
  >
  let count = 0
  let code: string | null = null
  let last: string | null = null
  for (const r of rows) {
    if (r.status === 'running') continue
    if (r.status !== 'failed' && r.status !== 'interrupted') break
    count++
    if (count === 1) {
      code = r.error_code == null ? null : String(r.error_code)
      last = iso(r.finished_at) ?? iso(r.created_at)
    }
  }
  return { count, code, last_at: last }
}
