// Hub enhancement 47: the retirement wizard's rows (nivaro_hub_retirements, migration 579).
//
// One row per retirement of an app. Five steps, always in this order, each started by a person's
// sign-off (who, when, a note): freeze writes → export data → final notice → stop and remove →
// archive the Hub record. Until `remove` has started, the last done step can be undone (and the
// whole retirement cancelled, which undoes every done step newest first); from `remove` on,
// nothing goes back.
//
// The runner holds the row by a LEASE, not a Redis lock: a start or resume flips the row to
// `running` with a fresh `runner` token by compare-and-set on `rev`, every heartbeat and every
// write it makes names that token, and a runner whose write matches nothing (its row was healed
// to `interrupted` and resumed elsewhere) stops at once — a run that lost its lease never
// continues. A row `running` whose heartbeat is older than STALE_MS is healed to `interrupted`
// (the tick, and every read); Resume continues the interrupted step from its stored input.
import { randomUUID } from 'node:crypto'
import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'

export const RETIREMENTS = 'nivaro_hub_retirements'
export const HEARTBEAT_MS = 30_000
export const STALE_MS = 3 * 60_000

export type RetireStepKey = 'freeze' | 'export' | 'notice' | 'remove' | 'archive'
export type RetireStepState = 'pending' | 'running' | 'done' | 'failed' | 'interrupted'
export type RetireStatus = 'open' | 'running' | 'interrupted' | 'done' | 'cancelled'

export const RETIRE_STEPS: ReadonlyArray<{
  key: RetireStepKey
  label: string
  /** Undone by the wizard's Undo (and Cancel). */
  reversible: boolean
}> = [
  { key: 'freeze', label: 'Freeze writes', reversible: true },
  { key: 'export', label: 'Export data', reversible: true },
  { key: 'notice', label: 'Final notice to users', reversible: true },
  { key: 'remove', label: 'Stop and remove', reversible: false },
  { key: 'archive', label: 'Archive the Hub record', reversible: false }
]
export const STEP_KEYS = RETIRE_STEPS.map((s) => s.key)
export const OPEN_STATUSES: readonly RetireStatus[] = ['open', 'running', 'interrupted']

export interface StepLogLine {
  at: string
  by: string | null
  /** signed_off | done | failed | interrupted | resumed | undone | undo_failed */
  what: string
  note: string | null
}

export interface RetireStep {
  key: RetireStepKey
  label: string
  state: RetireStepState
  signed_off_by: string | null
  signed_off_at: string | null
  /** The person's note at sign-off (why, what they checked). */
  sign_note: string | null
  started_at: string | null
  finished_at: string | null
  /** One sentence: what happened or why it failed. Never a secret or driver dump. */
  note: string | null
  /** What the step did, per environment (what Undo / Resume read). */
  detail: Record<string, unknown>
  /** What the sign-off asked for (no confirm text), kept so Resume runs the same thing. */
  input: Record<string, unknown>
  log: StepLogLine[]
}

export interface RetireEnvPlan {
  id: number
  key: string
  status: string
  production: boolean
  /** How the Hub reaches it: its stack (Docker), its shared deployment, or by hand. */
  kind: 'docker' | 'shared' | 'manual'
  /** Freeze over the hub link (maintenance), the tenant status (shared), or nothing to freeze. */
  freeze: 'link' | 'status' | 'manual' | 'none'
  has_link: boolean
  stack: string | null
  database: boolean
  files_target: boolean
}

export interface RetirePlan {
  app: { id: number; key: string; name: string }
  environments: RetireEnvPlan[]
  production: boolean
}

export interface Retirement {
  id: number
  app_id: number
  status: RetireStatus
  step: string | null
  steps: RetireStep[]
  plan: RetirePlan | null
  plan_hash: string | null
  notice: string | null
  /** env id → checklist run claimed for this retirement. */
  checklists: Record<string, number>
  error: string | null
  runner: string | null
  rev: number
  heartbeat_at: string | null
  started_by: string | null
  created_at: string | null
  updated_at: string | null
  finished_at: string | null
}

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function parse<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback
  if (typeof v === 'object') return v as T
  try {
    return JSON.parse(String(v)) as T
  } catch {
    return fallback
  }
}

export function newSteps(): RetireStep[] {
  return RETIRE_STEPS.map((s) => ({
    key: s.key,
    label: s.label,
    state: 'pending',
    signed_off_by: null,
    signed_off_at: null,
    sign_note: null,
    started_at: null,
    finished_at: null,
    note: null,
    detail: {},
    input: {},
    log: []
  }))
}

export function retirementFromRow(r: Record<string, unknown>): Retirement {
  const stored = parse<RetireStep[]>(r.steps, [])
  // Every step present, in order, whatever the row holds (a step it lacks reads pending).
  const steps = newSteps().map((fresh) => {
    const s = stored.find((x) => x?.key === fresh.key)
    return s
      ? { ...fresh, ...s, label: fresh.label, log: Array.isArray(s.log) ? s.log : [] }
      : fresh
  })
  return {
    id: Number(r.id),
    app_id: Number(r.app_id),
    status: String(r.status ?? 'open') as RetireStatus,
    step: r.step == null ? null : String(r.step),
    steps,
    plan: parse<RetirePlan | null>(r.plan, null),
    plan_hash: r.plan_hash == null ? null : String(r.plan_hash),
    notice: r.notice == null ? null : String(r.notice),
    checklists: parse<Record<string, number>>(r.checklists, {}),
    error: r.error == null ? null : String(r.error),
    runner: r.runner == null ? null : String(r.runner),
    rev: Number(r.rev ?? 0),
    heartbeat_at: iso(r.heartbeat_at),
    started_by: r.started_by == null ? null : String(r.started_by),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    finished_at: iso(r.finished_at)
  }
}

export async function readRetirement(id: number): Promise<Retirement | null> {
  const r = (await db(RETIREMENTS).where({ id }).first()) as Record<string, unknown> | undefined
  return r ? retirementFromRow(r) : null
}

export async function openRetirementOf(appId: number): Promise<Retirement | null> {
  const r = (await db(RETIREMENTS)
    .where({ app_id: appId })
    .whereIn('status', OPEN_STATUSES as RetireStatus[])
    .orderBy('id', 'desc')
    .first()) as Record<string, unknown> | undefined
  return r ? retirementFromRow(r) : null
}

export async function listRetirements(o: { appIds?: number[] | null; limit?: number } = {}) {
  const q = db(RETIREMENTS)
    .orderBy('id', 'desc')
    .limit(Math.max(1, Math.min(200, o.limit ?? 100)))
  if (o.appIds) {
    if (!o.appIds.length) return []
    q.whereIn('app_id', o.appIds)
  }
  return ((await q) as Array<Record<string, unknown>>).map(retirementFromRow)
}

export async function createRetirement(o: {
  appId: number
  plan: RetirePlan
  planHash: string
  notice: string | null
  by: string | null
  now?: Date
}): Promise<number> {
  const now = o.now ?? new Date()
  return Number(
    await insertReturningId(db, RETIREMENTS, {
      app_id: o.appId,
      status: 'open',
      step: null,
      steps: JSON.stringify(newSteps()),
      plan: JSON.stringify(o.plan),
      plan_hash: o.planHash,
      notice: o.notice,
      checklists: JSON.stringify({}),
      rev: 0,
      started_by: o.by && /^[0-9a-f-]{36}$/i.test(o.by) ? o.by : null,
      created_at: now,
      updated_at: now
    })
  )
}

export interface RetirePatch {
  status?: RetireStatus
  step?: string | null
  steps?: RetireStep[]
  notice?: string | null
  checklists?: Record<string, number>
  error?: string | null
  runner?: string | null
  heartbeat?: boolean
  finished?: boolean
}

function patchRow(p: RetirePatch, now: Date): Record<string, unknown> {
  const out: Record<string, unknown> = { updated_at: now }
  if (p.status !== undefined) out.status = p.status
  if (p.step !== undefined) out.step = p.step
  if (p.steps !== undefined) out.steps = JSON.stringify(p.steps)
  if (p.notice !== undefined) out.notice = p.notice
  if (p.checklists !== undefined) out.checklists = JSON.stringify(p.checklists)
  if (p.error !== undefined) out.error = p.error ? p.error.slice(0, 1000) : null
  if (p.runner !== undefined) out.runner = p.runner
  if (p.heartbeat) out.heartbeat_at = now
  if (p.finished) out.finished_at = now
  return out
}

/**
 * Compare-and-set on `rev`: true when this write won (the row was still at `rev`). Every write
 * bumps rev, so two people starting a step at once cannot both win.
 */
export async function casRetirement(
  id: number,
  rev: number,
  p: RetirePatch,
  now = new Date()
): Promise<boolean> {
  const n = await db(RETIREMENTS)
    .where({ id, rev })
    .update({ ...patchRow(p, now), rev: rev + 1 })
  return Number(n) === 1
}

/** A write by the runner holding `runner`: false = the lease is gone (stop). */
export async function runnerWrite(
  id: number,
  runner: string,
  p: RetirePatch,
  now = new Date()
): Promise<boolean> {
  const n = await db(RETIREMENTS)
    .where({ id, runner, status: 'running' })
    .update({ ...patchRow(p, now), rev: db.raw('rev + 1') })
  return Number(n) === 1
}

export const newRunnerToken = () => randomUUID()

/** Rows `running` whose heartbeat is older than STALE_MS become `interrupted` (idempotent). */
export async function healStale(now = new Date()): Promise<number[]> {
  const cutoff = new Date(now.getTime() - STALE_MS)
  const rows = (await db(RETIREMENTS)
    .where({ status: 'running' })
    .where((q) => q.whereNull('heartbeat_at').orWhere('heartbeat_at', '<', cutoff))
    .select('*')) as Array<Record<string, unknown>>
  const healed: number[] = []
  for (const raw of rows) {
    const r = retirementFromRow(raw)
    const steps = r.steps.map((s) =>
      s.state === 'running'
        ? {
            ...s,
            state: 'interrupted' as const,
            note: 'The Hub process running this step stopped. Resume continues it.',
            log: addLog(s.log, { what: 'interrupted', by: null, note: null }, now)
          }
        : s
    )
    if (await casRetirement(r.id, r.rev, { status: 'interrupted', steps, runner: null }, now))
      healed.push(r.id)
  }
  return healed
}

export function addLog(
  log: StepLogLine[],
  line: Omit<StepLogLine, 'at'>,
  now = new Date()
): StepLogLine[] {
  return [...log, { ...line, at: now.toISOString() }].slice(-30)
}

export function stepOf(r: Pick<Retirement, 'steps'>, key: RetireStepKey): RetireStep {
  return r.steps.find((s) => s.key === key) as RetireStep
}

export function withStep(
  steps: RetireStep[],
  key: RetireStepKey,
  patch: Partial<RetireStep>
): RetireStep[] {
  return steps.map((s) => (s.key === key ? { ...s, ...patch } : s))
}

/** The step a person may start now: the first one not done (null when every one is). */
export function nextStep(r: Pick<Retirement, 'steps'>): RetireStep | null {
  return r.steps.find((s) => s.state !== 'done') ?? null
}

/** The step Undo would undo: the last done one, while it and every later step are reversible. */
export function undoableStep(r: Pick<Retirement, 'steps'>): RetireStep | null {
  const removeStarted = (['remove', 'archive'] as RetireStepKey[]).some((k) => {
    const s = stepOf(r, k)
    return s.state !== 'pending' || s.signed_off_at != null
  })
  if (removeStarted) return null
  const done = r.steps.filter((s) => s.state === 'done')
  const last = done[done.length - 1]
  if (!last) return null
  return RETIRE_STEPS.find((d) => d.key === last.key)?.reversible ? last : null
}
