import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import {
  emptyStepState,
  type PlanDoc,
  type PlanStatus,
  type PlanStepDef,
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
 */

const MAX_STEPS = 20
/** A plan nobody started expires like a single proposal does. */
const PROPOSED_EXPIRY_MS = 60 * 60 * 1000
const STOP_PREFIX = 'aiplan-'
/** A plan still `running` with no step change for this long lost its process. */
const STALE_RUNNING_MS = 15 * 60 * 1000

export const PLAN_ACTION_TYPE = 'plan'
export const PLAN_COLLECTION = '__plan__'

export interface StoredPlanDoc extends PlanDoc {
  title: string
  /** When the failed + remaining steps were last rebuilt for a retry. */
  rechecked_at?: string | null
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
  /** The model reads this — the plan does NOT run on its own. */
  expires_note?: string
}

export interface ProposePlanInput {
  title?: string
  steps?: Array<Record<string, unknown>>
}

function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode })
}

function parseDoc(raw: unknown): StoredPlanDoc {
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
  return { title: String(doc.title ?? 'Plan'), steps, state, rechecked_at: doc.rechecked_at }
}

function iso(v: unknown): string | null {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function sameId(a: unknown, b: unknown): boolean {
  return String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase()
}

async function isAdmin(user: User): Promise<boolean> {
  const { isAdminRole } = await import('./user-scopes.js')
  return isAdminRole(user.role)
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
        preview: s.preview,
        condition: s.condition ? (s.condition.label ?? 'Has a condition') : null,
        state: doc.state.find((x) => x.id === s.id) ?? emptyStepState(s.id),
        ...(changed?.has(s.id) ? { preview_changed: true } : {})
      })),
    records_changed: totalRecordsChanged(doc),
    created_at: iso(row.created_at),
    executed_at: iso(row.executed_at),
    rechecked_at: doc.rechecked_at ?? null
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
export async function proposePlan(user: User, input: ProposePlanInput): Promise<PlanView> {
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

  const doc: StoredPlanDoc = { title, steps, state: steps.map((s) => emptyStepState(s.id)) }
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

async function loadPlan(id: string): Promise<{ row: Record<string, unknown>; doc: StoredPlanDoc }> {
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
  if (!sameId(row.user, user.id) && !(await isAdmin(user))) throw httpError('Plan not found', 404)
  if (row.status === 'proposed' && isExpired(row)) {
    await db('nivaro_ai_proposals').where({ id, status: 'proposed' }).update({ status: 'expired' })
    return planView({ ...row, status: 'expired' }, doc)
  }
  return planView(row, doc)
}

function isExpired(row: Record<string, unknown>): boolean {
  return Date.now() - new Date(String(row.created_at)).getTime() > PROPOSED_EXPIRY_MS
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

function assertOwner(row: Record<string, unknown>, user: User): void {
  if (!sameId(row.user, user.id))
    throw httpError('Only the person who asked can run this plan', 403)
}

/** Atomically move a plan from one of `from` to `to`; false = someone else did. */
async function claim(id: string, from: string[], to: string): Promise<boolean> {
  const n = await db('nivaro_ai_proposals')
    .where({ id })
    .whereIn('status', from)
    .update({ status: to })
  return Number(n) === 1
}

function emitPlan(userId: string, view: PlanView, step?: PlanStepState): void {
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
  if (status === 'proposed' && isExpired(row)) {
    await db('nivaro_ai_proposals').where({ id, status: 'proposed' }).update({ status: 'expired' })
    throw httpError('This plan expired — ask again', 410)
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
  if (!(await claim(id, ['proposed', 'paused'], 'running'))) {
    throw httpError('This plan is already running', 409)
  }
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
          return kind.execute(user, payload, { planId: id, stepId: step.id })
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
