import { randomUUID } from 'node:crypto'
import { adminBaseUrl } from '../admin-base.js'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import { type PlanImpact, planImpact } from './ai-plan-impact.js'
import {
  emptyStepState,
  type PlanDoc,
  type PlanStatus,
  type PlanStepDef,
  type PlanStepMade,
  type PlanStepState,
  resetFailedSteps,
  runPlanSteps,
  statusFromState,
  totalRecordsChanged
} from './ai-plan-runner.js'
import {
  checkStepCondition,
  getPlanStepKind,
  listPlanStepKinds,
  prepareCondition
} from './ai-plan-steps.js'
import { getApp } from './io-holder.js'

/**
 * Ask AI multi-step PLANS (#1807, #2000, #2007, #1902, #1953).
 *
 * A plan is a numbered list of proposals the model drafts in one go
 * ("close out the lines on these 12 POs and tell their owners"). It is a
 * row in nivaro_ai_proposals with action_type 'plan' — no table of its own:
 *   payload  JSON PlanDoc {title, steps[], state[]}  (what runs + how far)
 *   preview  JSON {title, count}                      (the list view line)
 *   status   proposed | running | paused | executed | failed | rejected | expired
 *
 * Every step is built (validated + previewed) AS THE PERSON when the plan is
 * proposed, by its step kind (services/ai-plan-steps.ts); nothing mutates
 * until the person approves. Approval runs the steps in order as the person
 * (services/ai-plan-runner.ts owns the order rules), either all together or
 * one step at a time; a refused step stops the plan, a step whose condition
 * fails is skipped. Each step change is saved and pushed to the person's
 * socket room as `ai:plan`, so the card (and any other tab) shows it live.
 * A failed plan can be retried: the failed and remaining steps are rebuilt
 * as the person NOW (preview re-checked), then run from where it stopped.
 *
 * Wave 2 (#1900, #1903, #1952, #1954, #2002, #2004, #2006, #1849) keeps
 * everything on the same row: the impact line is computed from the step
 * previews (ai-plan-impact.ts), `scheduled` is a status the per-minute
 * `ai-plans-scheduled` job picks up (ai-plan-schedule.ts), what each step
 * wrote is kept in `doc.made` for the change report and undo
 * (ai-plan-report.ts, ai-plan-undo.ts), and the approver hears when the plan
 * finishes.
 */

const MAX_STEPS = 20
/** A plan nobody started expires like a single proposal does. */
const PROPOSED_EXPIRY_MS = 60 * 60 * 1000
const STOP_PREFIX = 'aiplan-'
/** A plan still `running` with no step change for this long lost its process. */
const STALE_RUNNING_MS = 15 * 60 * 1000

export const PLAN_ACTION_TYPE = 'plan'
export const PLAN_COLLECTION = '__plan__'

export interface PlanSchedule {
  run_at: string
  by: string
  at: string
}

export interface StoredPlanDoc extends PlanDoc {
  title: string
  /** When the failed + remaining steps were last rebuilt for a retry. */
  rechecked_at?: string | null
  /** Who approved the run (ran it, or scheduled it) — told when it finishes. */
  approved_by?: string | null
  approved_at?: string | null
  /** A plan sent back for approval again expires an hour after this. */
  reopened_at?: string | null
  schedule?: PlanSchedule | null
  /** Why a scheduled plan came back for approval instead of running. */
  held?: { at: string; reason: string } | null
  /** step id → what the step wrote (raw; never returned by planView). */
  made?: Record<string, PlanStepMade>
  /** Where the plan came from when not the chat. */
  template?: { key: string; label: string } | null
  source?: { kind: string; label: string; ref?: string | null } | null
  /** The draft flow made from this plan (#1849). */
  flow_id?: string | null
}

export interface PlanStepView {
  id: string
  n: number
  kind: string
  kind_label: string
  title: string
  preview: Record<string, unknown>
  condition: string | null
  state: PlanStepState
  /** The retry re-check changed what this step will do. */
  preview_changed?: boolean
}

export interface PlanView {
  plan_id: string
  title: string
  status: PlanStatus
  steps: PlanStepView[]
  records_changed: number
  created_at: string | null
  executed_at: string | null
  rechecked_at: string | null
  /** #1900 — "Touches 34 records in 3 collections, messages 12 people". */
  impact: PlanImpact
  schedule: PlanSchedule | null
  held: { at: string; reason: string } | null
  approved_by: string | null
  approved_at: string | null
  template: { key: string; label: string } | null
  source: { kind: string; label: string; ref?: string | null } | null
  flow_id: string | null
  /** Steps whose writes were captured (the change report reads them). */
  made_steps: string[]
  /** The model reads this — the plan does NOT run on its own. */
  expires_note?: string
}

export interface ProposePlanInput {
  title?: string
  steps?: Array<Record<string, unknown>>
}

export function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode })
}

export function parseDoc(raw: unknown): StoredPlanDoc {
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      v = null
    }
  }
  const doc = (v && typeof v === 'object' ? v : {}) as Partial<StoredPlanDoc>
  const steps = Array.isArray(doc.steps) ? doc.steps : []
  const state = Array.isArray(doc.state) ? doc.state : []
  for (const s of steps) if (!state.some((x) => x.id === s.id)) state.push(emptyStepState(s.id))
  // Every key passes through — a parser that rebuilds the doc drops new ones.
  return { ...doc, title: String(doc.title ?? 'Plan'), steps, state }
}

function iso(v: unknown): string | null {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export function sameId(a: unknown, b: unknown): boolean {
  return String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase()
}

export async function isAdmin(user: User): Promise<boolean> {
  const { isAdminRole } = await import('./user-scopes.js')
  return isAdminRole(user.role)
}

function withoutRows(p: Record<string, unknown>): Record<string, unknown> {
  if (!p || !('rows' in p)) return p
  const { rows: _rows, ...rest } = p
  return rest
}

export function planView(
  row: Record<string, unknown>,
  doc: StoredPlanDoc,
  changed?: Set<string>
): PlanView {
  return {
    plan_id: String(row.id),
    title: doc.title,
    status: String(row.status) as PlanStatus,
    steps: [...doc.steps]
      .sort((a, b) => a.n - b.n)
      .map((s) => ({
        id: s.id,
        n: s.n,
        kind: s.kind,
        kind_label: getPlanStepKind(s.kind)?.label ?? s.kind,
        title: s.title,
        // Record-by-record rows are the change report's (GET …/changes).
        preview: withoutRows(s.preview),
        condition: s.condition ? (s.condition.label ?? 'Has a condition') : null,
        state: doc.state.find((x) => x.id === s.id) ?? emptyStepState(s.id),
        ...(changed?.has(s.id) ? { preview_changed: true } : {})
      })),
    records_changed: totalRecordsChanged(doc),
    created_at: iso(row.created_at),
    executed_at: iso(row.executed_at),
    rechecked_at: doc.rechecked_at ?? null,
    impact: planImpact(doc.steps),
    schedule: doc.schedule ?? null,
    held: doc.held ?? null,
    approved_by: doc.approved_by ?? null,
    approved_at: doc.approved_at ?? null,
    template: doc.template ?? null,
    source: doc.source ?? null,
    flow_id: doc.flow_id ?? null,
    made_steps: Object.keys(doc.made ?? {})
  }
}

/** The step kinds as one line each, for the propose_plan tool description. */
export function describePlanStepKinds(): string {
  return listPlanStepKinds()
    .map((k) => `- ${k.describe}`)
    .join('\n')
}

/**
 * Build and store a plan. Every step is proposed AS THE PERSON; the first
 * step that does not validate refuses the whole plan with its number, so
 * the model can fix it and propose again.
 */
export async function proposePlan(
  user: User,
  input: ProposePlanInput,
  extra: Pick<StoredPlanDoc, 'template' | 'source'> = {}
): Promise<PlanView> {
  const title =
    String(input.title ?? '')
      .trim()
      .slice(0, 200) || 'Plan'
  const raw = Array.isArray(input.steps) ? input.steps : []
  if (raw.length === 0) throw new Error('A plan needs at least one step')
  if (raw.length > MAX_STEPS) throw new Error(`A plan can have at most ${MAX_STEPS} steps`)

  const steps: PlanStepDef[] = []
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] ?? {}
    const kindName = String(r.kind ?? r.action_type ?? '')
    const kind = getPlanStepKind(kindName)
    if (!kind) {
      throw new Error(
        `Step ${i + 1}: unknown kind "${kindName}" (one of ${listPlanStepKinds()
          .map((k) => k.kind)
          .join(', ')})`
      )
    }
    const { kind: _k, action_type: _a, title: stepTitle, condition: rawCondition, ...stepInput } = r
    try {
      const built = await kind.propose(user, stepInput)
      const condition = await prepareCondition(user, rawCondition, built.targets)
      steps.push({
        id: randomUUID(),
        n: i + 1,
        kind: kind.kind,
        title:
          String(stepTitle ?? '')
            .trim()
            .slice(0, 200) || built.preview.summary,
        input: stepInput,
        payload: built.payload,
        preview: built.preview,
        targets: built.targets ?? null,
        condition
      })
    } catch (err) {
      throw new Error(`Step ${i + 1} (${kind.kind}): ${(err as Error)?.message ?? 'invalid'}`)
    }
  }

  const doc: StoredPlanDoc = {
    title,
    steps,
    state: steps.map((s) => emptyStepState(s.id)),
    ...(extra.template ? { template: extra.template } : {}),
    ...(extra.source ? { source: extra.source } : {})
  }
  const id = randomUUID()
  const createdAt = new Date()
  await db('nivaro_ai_proposals').insert({
    id,
    user: user.id,
    action_type: PLAN_ACTION_TYPE,
    collection: PLAN_COLLECTION,
    payload: JSON.stringify(doc),
    preview: JSON.stringify({ title, count: steps.length }),
    status: 'proposed',
    created_at: createdAt
  })
  return {
    ...planView({ id, status: 'proposed', created_at: createdAt }, doc),
    expires_note:
      'The user must approve this plan in the UI (all steps, or one at a time) within 1 hour; NOTHING runs until then.'
  }
}

export async function loadPlan(
  id: string
): Promise<{ row: Record<string, unknown>; doc: StoredPlanDoc }> {
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw httpError('Plan not found', 404)
  const row = (await db('nivaro_ai_proposals').where({ id }).first()) as
    | Record<string, unknown>
    | undefined
  if (!row || row.action_type !== PLAN_ACTION_TYPE) throw httpError('Plan not found', 404)
  return { row, doc: parseDoc(row.payload) }
}

/** The plan as its owner (or an administrator) sees it. */
export async function getPlan(user: User, id: string): Promise<PlanView> {
  const { row, doc } = await loadPlan(id)
  await assertCanReadPlan(user, row)
  if (row.status === 'proposed' && isExpired(row, doc)) {
    await db('nivaro_ai_proposals').where({ id, status: 'proposed' }).update({ status: 'expired' })
    return planView({ ...row, status: 'expired' }, doc)
  }
  return planView(row, doc)
}

/** Its owner or an administrator; anyone else gets a 404. */
export async function assertCanReadPlan(user: User, row: Record<string, unknown>): Promise<void> {
  if (!sameId(row.user, user.id) && !(await isAdmin(user))) throw httpError('Plan not found', 404)
}

/** A proposed plan waits an hour for approval — counted from when it was
 *  made, or from when a scheduled run sent it back for approval again. */
export function isExpired(row: Record<string, unknown>, doc?: StoredPlanDoc | null): boolean {
  const from = doc?.reopened_at ?? row.created_at
  return Date.now() - new Date(String(from)).getTime() > PROPOSED_EXPIRY_MS
}

/** A run whose process died: still `running`, nothing has moved for a while. */
export function isStaleRun(doc: PlanDoc, now = Date.now()): boolean {
  let last = 0
  for (const s of doc.state) {
    for (const t of [s.started_at, s.finished_at]) {
      const ms = t ? new Date(t).getTime() : 0
      if (ms > last) last = ms
    }
  }
  return last > 0 && now - last > STALE_RUNNING_MS
}

export function assertOwner(row: Record<string, unknown>, user: User): void {
  if (!sameId(row.user, user.id))
    throw httpError('Only the person who asked can run this plan', 403)
}

/** Atomically move a plan from one of `from` to `to`; false = someone else did. */
export async function claim(id: string, from: string[], to: string): Promise<boolean> {
  const n = await db('nivaro_ai_proposals')
    .where({ id })
    .whereIn('status', from)
    .update({ status: to })
  return Number(n) === 1
}

export function emitPlan(userId: string, view: PlanView, step?: PlanStepState): void {
  const app = getApp()
  // A copy: the runner keeps mutating the step objects after this returns.
  const payload = JSON.parse(
    JSON.stringify({
      plan_id: view.plan_id,
      status: view.status,
      records_changed: view.records_changed,
      ...(step ? { step } : {}),
      plan: view
    })
  )
  app?.io?.to(`user:${userId}`).emit('ai:plan', payload)
}

/**
 * Approve and run. `mode: 'all'` runs every remaining step; `'next'` runs
 * the next pending step and pauses (step-by-step approval). Returns at once
 * with the plan marked running; the steps run in the background and every
 * change lands on the person's socket (`ai:plan`) and on GET /ai/plans/:id.
 */
export async function runPlan(
  user: User,
  id: string,
  opts: { mode?: 'all' | 'next' } = {}
): Promise<PlanView> {
  const { row, doc } = await loadPlan(id)
  assertOwner(row, user)
  const status = String(row.status)
  if (status === 'proposed' && isExpired(row, doc)) {
    await db('nivaro_ai_proposals').where({ id, status: 'proposed' }).update({ status: 'expired' })
    throw httpError('This plan expired — ask again', 410)
  }
  if (status === 'scheduled') {
    throw httpError('This plan is scheduled — cancel the schedule to run it now', 409)
  }
  if (status !== 'proposed' && status !== 'paused') {
    throw httpError(
      status === 'failed'
        ? 'A step failed — retry the plan to re-check it first'
        : `This plan is already ${status}`,
      409
    )
  }
  const ordered = [...doc.steps].sort((a, b) => a.n - b.n)
  const next = ordered.find((s) => doc.state.find((x) => x.id === s.id)?.status === 'pending')
  if (!next) throw httpError('Nothing left to run', 409)
  doc.approved_by = String(user.id)
  doc.approved_at = new Date().toISOString()
  doc.held = null
  const n = await db('nivaro_ai_proposals')
    .where({ id })
    .whereIn('status', ['proposed', 'paused'])
    .update({ status: 'running', payload: JSON.stringify(doc) })
  if (Number(n) !== 1) throw httpError('This plan is already running', 409)
  const through = opts.mode === 'next' ? next.id : null
  void executePlan(user, id, doc, through).catch((err) => {
    getApp()?.log?.error({ err, plan: id }, 'AI plan run failed')
  })
  await logActivity({
    action: 'ai-plan-run',
    user: user.id,
    comment: `plan ${id}: ${opts.mode === 'next' ? `step ${next.n}` : 'all remaining steps'}`
  })
  return planView({ ...row, status: 'running' }, doc)
}

/** The background half of runPlan — exported for tests. */
export async function executePlan(
  user: User,
  id: string,
  doc: StoredPlanDoc,
  through: string | null
): Promise<PlanView> {
  const app = getApp()
  const { registerStream } = await import('./ai-stream-delivery.js')
  const stopper = app ? registerStream(app, `${STOP_PREFIX}${id}`, String(user.id)) : null
  const save = async (status: PlanStatus, extra: Record<string, unknown> = {}) => {
    await db('nivaro_ai_proposals')
      .where({ id })
      .update({ payload: JSON.stringify(doc), status, ...extra })
  }
  const base = (await db('nivaro_ai_proposals').where({ id }).first('id', 'created_at')) as
    | Record<string, unknown>
    | undefined
  try {
    const out = await runPlanSteps(
      doc,
      {
        checkCondition: (step) => checkStepCondition(user, step),
        executeStep: async (step, payload) => {
          const kind = getPlanStepKind(step.kind)
          if (!kind) throw new Error(`Step kind "${step.kind}" is no longer available`)
          const { made, ...out } = await kind.execute(user, payload, {
            planId: id,
            stepId: step.id
          })
          // What it wrote stays on the doc, out of the step result the card shows.
          if (made && made.records.length > 0) doc.made = { ...(doc.made ?? {}), [step.id]: made }
          return out
        },
        onProgress: async (s) => {
          await save('running')
          emitPlan(String(user.id), planView({ ...base, status: 'running' }, doc), s)
        },
        shouldStop: stopper ? () => stopper.stopped() : undefined
      },
      { through }
    )
    const finished =
      out.status === 'executed' || out.status === 'failed' || out.status === 'rejected'
    await save(out.status, finished ? { executed_at: new Date(), result: JSON.stringify(out) } : {})
    const view = planView(
      { ...base, status: out.status, executed_at: finished ? new Date() : null },
      doc
    )
    emitPlan(String(user.id), view)
    await logActivity({
      action: 'ai-plan-step',
      user: user.id,
      comment: `plan ${id}: ${out.status}, ${out.records_changed} record(s) changed${out.failed_step ? `, stopped at step ${doc.steps.find((s) => s.id === out.failed_step)?.n ?? '?'}` : ''}`
    })
    if (out.status === 'executed' || out.status === 'failed') {
      await notifyPlanFinished(id, doc, view, String(doc.approved_by ?? user.id))
    }
    return view
  } catch (err) {
    // The runner never throws for a step; this is persistence failing.
    // Leave the plan readable as failed rather than stuck running.
    await save(statusFromState(doc) === 'executed' ? 'executed' : 'failed').catch(() => undefined)
    throw err
  } finally {
    stopper?.dispose()
  }
}

/**
 * Get a failed plan ready to try again (#1902): the failed step and every
 * step after it are rebuilt AS THE PERSON NOW (a bulk step re-resolves its
 * filter and, after a partial run, keeps only the records that refused), so
 * the card shows what will actually happen. The plan goes to `paused`; the
 * person runs it again. A step that no longer builds keeps the plan failed
 * with the reason.
 */
export async function recheckPlan(user: User, id: string): Promise<PlanView> {
  const { row, doc } = await loadPlan(id)
  assertOwner(row, user)
  const status = String(row.status)
  if (status !== 'failed' && !(status === 'running' && isStaleRun(doc))) {
    throw httpError('Only a failed plan can be retried', 409)
  }
  const ordered = [...doc.steps].sort((a, b) => a.n - b.n)
  const firstFailed = ordered.findIndex((s) => {
    const st = doc.state.find((x) => x.id === s.id)?.status
    return st === 'failed' || st === 'running'
  })
  if (firstFailed < 0) throw httpError('No failed step to retry', 409)

  const changed = new Set<string>()
  for (const step of ordered.slice(firstFailed)) {
    const state = doc.state.find((x) => x.id === step.id)
    if (
      !state ||
      (state.status !== 'pending' && state.status !== 'failed' && state.status !== 'running')
    )
      continue
    const kind = getPlanStepKind(step.kind)
    try {
      if (!kind) throw new Error(`Step kind "${step.kind}" is no longer available`)
      const fresh = kind.recheck
        ? await kind.recheck(user, step, (state.result as Record<string, unknown>) ?? null)
        : await kind.propose(user, step.input)
      if (JSON.stringify(fresh.preview) !== JSON.stringify(step.preview)) changed.add(step.id)
      step.payload = fresh.payload
      step.preview = fresh.preview
      // The condition keeps its original snapshot ("unchanged since the
      // plan was made"), but checks the step's records as rebuilt.
      step.targets = fresh.targets ?? null
    } catch (err) {
      state.status = 'failed'
      state.error = `Re-check: ${(err as Error)?.message ?? 'the step no longer builds'}`
      doc.rechecked_at = new Date().toISOString()
      await db('nivaro_ai_proposals')
        .where({ id, status })
        .update({ payload: JSON.stringify(doc), status: 'failed' })
      const view = planView({ ...row, status: 'failed' }, doc, changed)
      emitPlan(String(user.id), view)
      return view
    }
  }
  resetFailedSteps(doc)
  doc.rechecked_at = new Date().toISOString()
  const n = await db('nivaro_ai_proposals')
    .where({ id, status })
    .update({ payload: JSON.stringify(doc), status: 'paused' })
  if (Number(n) !== 1) throw httpError('The plan changed while it was re-checked', 409)
  const view = planView({ ...row, status: 'paused' }, doc, changed)
  emitPlan(String(user.id), view)
  return view
}

/**
 * Stop or discard. A plan not yet started (or paused) is rejected at once;
 * a running one stops before its next step (the step in flight finishes).
 */
export async function cancelPlan(user: User, id: string): Promise<PlanView> {
  const { row, doc } = await loadPlan(id)
  assertOwner(row, user)
  const status = String(row.status)
  if (status === 'running') {
    const app = getApp()
    if (app) {
      const { requestStreamStop } = await import('./ai-stream-delivery.js')
      await requestStreamStop(app, `${STOP_PREFIX}${id}`, { id: String(user.id), admin: false })
    }
    return planView(row, doc)
  }
  if (status === 'proposed' || status === 'paused' || status === 'failed') {
    for (const s of doc.state) if (s.status === 'pending') s.status = 'cancelled'
    await db('nivaro_ai_proposals')
      .where({ id })
      .whereIn('status', ['proposed', 'paused', 'failed'])
      .update({ status: 'rejected', payload: JSON.stringify(doc) })
    const view = planView({ ...row, status: 'rejected' }, doc)
    emitPlan(String(user.id), view)
    return view
  }
  return planView(row, doc)
}

/** A plan's id is also a proposal id; the single-proposal routes refuse it. */
export function isPlanRow(row: { action_type?: unknown } | null | undefined): boolean {
  return row?.action_type === PLAN_ACTION_TYPE
}

/** The plan's page — where a notification about it lands. */
export function planLink(id: string): string | null {
  const base = adminBaseUrl()
  return base ? `${base}/ai-plans?plan=${encodeURIComponent(id)}` : null
}

/**
 * Tell the person who approved the plan how it ended (#2004) — through
 * notifyUser, so their own channels (push, Teams, email) and rules apply.
 * Failed steps are named. Never throws: the plan already finished.
 */
export async function notifyPlanFinished(
  id: string,
  doc: StoredPlanDoc,
  view: PlanView,
  approverId: string
): Promise<void> {
  const app = getApp()
  if (!app || !approverId) return
  try {
    const failed = view.steps.filter((s) => s.state.status === 'failed')
    const skipped = view.steps.filter((s) => s.state.status === 'skipped').length
    const changed = `${view.records_changed} record${view.records_changed === 1 ? '' : 's'} changed`
    const subject =
      view.status === 'executed'
        ? `Plan finished: ${doc.title}`.slice(0, 200)
        : `Plan stopped: ${doc.title}`.slice(0, 200)
    const lines = [
      view.status === 'executed'
        ? `All ${view.steps.length} step${view.steps.length === 1 ? '' : 's'} ran — ${changed}${skipped ? `, ${skipped} skipped` : ''}.`
        : `It stopped after ${changed}.`,
      ...failed.map((s) => `Step ${s.n} (${s.title}) failed: ${s.state.error ?? 'refused'}`)
    ]
    const url = planLink(id)
    const { notifyUser } = await import('./notification-channels.js')
    await notifyUser(app, approverId, {
      subject,
      message: lines.join('\n').slice(0, 2000),
      category: 'system',
      ...(url ? { target: { kind: 'external', url } } : {}),
      source: { kind: 'ai-plan', label: 'Ask AI plan', id }
    })
  } catch (err) {
    app.log?.warn?.({ err, plan: id }, 'AI plan finish notification failed')
  }
}

export interface PlanListRow {
  plan_id: string
  title: string
  status: PlanStatus
  owner: { id: string; name: string }
  approved_by: { id: string; name: string } | null
  approved_at: string | null
  created_at: string | null
  executed_at: string | null
  steps: number
  steps_failed: number
  records_changed: number
  impact: string
  schedule: PlanSchedule | null
  template: string | null
  source: string | null
  has_undo: boolean
}

/**
 * Plan history (#1954): newest first. Administrators may ask for every
 * plan (`scope: 'all'`); everyone else sees their own.
 */
export async function listPlans(
  user: User,
  opts: { scope?: string; status?: string; limit?: number; offset?: number } = {}
): Promise<{ data: PlanListRow[]; total: number }> {
  const all = opts.scope === 'all'
  if (all && !(await isAdmin(user))) throw httpError('Only administrators can list every plan', 403)
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200)
  const offset = Math.max(Number(opts.offset) || 0, 0)
  const base = () =>
    db('nivaro_ai_proposals')
      .where({ action_type: PLAN_ACTION_TYPE })
      .modify((q) => {
        if (!all) q.where('user', user.id)
        if (opts.status && /^[a-z]{3,20}$/.test(opts.status)) q.where('status', opts.status)
      })
  const [rows, counted] = await Promise.all([
    base()
      .orderBy('created_at', 'desc')
      .orderBy('id', 'asc')
      .offset(offset)
      .limit(limit)
      .select('id', 'user', 'status', 'payload', 'created_at', 'executed_at') as Promise<
      Array<Record<string, unknown>>
    >,
    base().count({ c: '*' }).first() as Promise<{ c?: unknown } | undefined>
  ])
  const docs = rows.map((r) => ({ row: r, doc: parseDoc(r.payload) }))
  const people = new Set<string>()
  for (const { row, doc } of docs) {
    people.add(String(row.user))
    if (doc.approved_by) people.add(String(doc.approved_by))
  }
  const names = new Map<string, string>()
  if (people.size > 0) {
    const us = (await db('nivaro_users')
      .whereIn('id', [...people])
      .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, unknown>>
    for (const u of us) {
      names.set(
        String(u.id).toUpperCase(),
        [u.first_name, u.last_name].filter(Boolean).join(' ') || String(u.email ?? u.id)
      )
    }
  }
  const person = (id: unknown) => ({
    id: String(id),
    name: names.get(String(id).toUpperCase()) ?? String(id)
  })
  return {
    data: docs.map(({ row, doc }) => ({
      plan_id: String(row.id),
      title: doc.title,
      status: String(row.status) as PlanStatus,
      owner: person(row.user),
      approved_by: doc.approved_by ? person(doc.approved_by) : null,
      approved_at: doc.approved_at ?? null,
      created_at: iso(row.created_at),
      executed_at: iso(row.executed_at),
      steps: doc.steps.length,
      steps_failed: doc.state.filter((s) => s.status === 'failed').length,
      records_changed: totalRecordsChanged(doc),
      impact: planImpact(doc.steps).summary,
      schedule: doc.schedule ?? null,
      template: doc.template?.label ?? null,
      source: doc.source?.label ?? null,
      has_undo: Object.values(doc.made ?? {}).some((m) => !m.undone_at)
    })),
    total: Number(counted?.c ?? 0)
  }
}
