import { db } from '../db/index.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import type { PlanStepDef } from './ai-plan-runner.js'
import { getPlanStepKind } from './ai-plan-steps.js'
import {
  assertOwner,
  emitPlan,
  executePlan,
  httpError,
  isExpired,
  loadPlan,
  PLAN_ACTION_TYPE,
  type PlanView,
  parseDoc,
  planLink,
  planView,
  type StoredPlanDoc
} from './ai-plans.js'
import { getApp } from './io-holder.js'

/**
 * Run an approved plan LATER (#1903) — "Friday 5pm". Scheduling IS the
 * approval: the plan moves to `scheduled` and the per-minute
 * `ai-plans-scheduled` job (server.ts, leader-leased like every cron) picks
 * it up when it is due. Before running, every pending step is rebuilt AS
 * THE OWNER NOW; when a step's set of records differs from what was
 * approved, or a step no longer builds, nothing runs — the plan goes back to
 * `proposed` with the fresh previews and the owner is told to approve again.
 */

const MIN_LEAD_MS = 60 * 1000
const MAX_LEAD_MS = 90 * 24 * 60 * 60 * 1000

export async function schedulePlan(user: User, id: string, runAtRaw: unknown): Promise<PlanView> {
  const { row, doc } = await loadPlan(id)
  assertOwner(row, user)
  const status = String(row.status)
  if (status === 'proposed' && isExpired(row, doc)) {
    throw httpError('This plan expired — ask again', 410)
  }
  if (status !== 'proposed' && status !== 'paused') {
    throw httpError(`A ${status} plan cannot be scheduled`, 409)
  }
  const runAt = new Date(String(runAtRaw ?? ''))
  if (Number.isNaN(runAt.getTime())) throw httpError('run_at must be a date and time', 400)
  const lead = runAt.getTime() - Date.now()
  if (lead < MIN_LEAD_MS) throw httpError('Pick a time at least a minute from now', 400)
  if (lead > MAX_LEAD_MS) throw httpError('A plan can be scheduled at most 90 days ahead', 400)
  const now = new Date().toISOString()
  doc.schedule = { run_at: runAt.toISOString(), by: String(user.id), at: now }
  doc.approved_by = String(user.id)
  doc.approved_at = now
  doc.held = null
  const n = await db('nivaro_ai_proposals')
    .where({ id, status })
    .update({ status: 'scheduled', payload: JSON.stringify(doc) })
  if (Number(n) !== 1) throw httpError('The plan changed — reload it', 409)
  await logActivity({
    action: 'ai-plan-schedule',
    user: user.id,
    comment: `plan ${id}: scheduled for ${doc.schedule.run_at}`
  })
  const view = planView({ ...row, status: 'scheduled' }, doc)
  emitPlan(String(user.id), view)
  return view
}

/** Take a plan off the schedule: back to waiting for approval (a fresh hour). */
export async function unschedulePlan(user: User, id: string): Promise<PlanView> {
  const { row, doc } = await loadPlan(id)
  assertOwner(row, user)
  if (row.status !== 'scheduled') throw httpError('This plan is not scheduled', 409)
  const next = doc.state.some((s) => s.status === 'done' || s.status === 'skipped')
    ? 'paused'
    : 'proposed'
  doc.schedule = null
  doc.reopened_at = new Date().toISOString()
  const n = await db('nivaro_ai_proposals')
    .where({ id, status: 'scheduled' })
    .update({ status: next, payload: JSON.stringify(doc) })
  if (Number(n) !== 1) throw httpError('The plan already started', 409)
  await logActivity({
    action: 'ai-plan-schedule',
    user: user.id,
    comment: `plan ${id}: unscheduled`
  })
  const view = planView({ ...row, status: next }, doc)
  emitPlan(String(user.id), view)
  return view
}

function sortedIds(t: PlanStepDef['targets']): string {
  return JSON.stringify(t ? [...t.ids].map(String).sort() : null)
}

export interface RecheckOutcome {
  /** Steps whose record set changed (by step number). */
  changed: number[]
  /** The first step that no longer builds, with why. */
  broken: { n: number; error: string } | null
}

/**
 * Rebuild every pending step as the owner now and compare what it would act
 * on with what was approved. Steps are updated in place with the fresh
 * payload + preview, so a held plan shows the person what changed.
 */
export async function recheckPendingSteps(user: User, doc: StoredPlanDoc): Promise<RecheckOutcome> {
  const out: RecheckOutcome = { changed: [], broken: null }
  for (const step of [...doc.steps].sort((a, b) => a.n - b.n)) {
    if (doc.state.find((x) => x.id === step.id)?.status !== 'pending') continue
    const kind = getPlanStepKind(step.kind)
    try {
      if (!kind) throw new Error(`Step kind "${step.kind}" is no longer available`)
      const fresh = await kind.propose(user, step.input)
      if (sortedIds(fresh.targets ?? null) !== sortedIds(step.targets ?? null))
        out.changed.push(step.n)
      step.payload = fresh.payload
      step.preview = fresh.preview
      step.targets = fresh.targets ?? null
    } catch (err) {
      out.broken = { n: step.n, error: (err as Error)?.message ?? 'it no longer builds' }
      return out
    }
  }
  return out
}

async function owner(row: Record<string, unknown>): Promise<User | null> {
  const { canSignIn, getUser } = await import('./users.js')
  const u = await getUser(String(row.user))
  // Only an account that could sign in right now runs a plan in its name.
  return u && canSignIn(u) ? u : null
}

/** Send a scheduled plan back for approval and tell its owner why. */
async function hold(
  id: string,
  row: Record<string, unknown>,
  doc: StoredPlanDoc,
  reason: string
): Promise<void> {
  const now = new Date().toISOString()
  doc.held = { at: now, reason }
  doc.schedule = null
  doc.reopened_at = now
  const next = doc.state.some((s) => s.status === 'done' || s.status === 'skipped')
    ? 'paused'
    : 'proposed'
  await db('nivaro_ai_proposals')
    .where({ id, status: 'running' })
    .update({ status: next, payload: JSON.stringify(doc) })
  const view = planView({ ...row, status: next }, doc)
  emitPlan(String(row.user), view)
  await logActivity({
    action: 'ai-plan-schedule',
    user: String(row.user),
    comment: `plan ${id}: held for approval — ${reason}`.slice(0, 500)
  })
  const app = getApp()
  if (!app) return
  try {
    const url = planLink(id)
    const { notifyUser } = await import('./notification-channels.js')
    await notifyUser(app, String(row.user), {
      subject: `Plan needs your approval again: ${doc.title}`.slice(0, 200),
      message: `It did not run at its scheduled time: ${reason}. Review the new preview and approve it again.`,
      category: 'system',
      ...(url ? { target: { kind: 'external', url } } : {}),
      source: { kind: 'ai-plan', label: 'Ask AI plan', id }
    })
  } catch (err) {
    app.log?.warn?.({ err, plan: id }, 'AI plan hold notification failed')
  }
}

/**
 * The `ai-plans-scheduled` tick: run every scheduled plan that is due, or
 * hold it for approval again. Each plan is claimed (scheduled → running)
 * before anything else, so two processes never run one twice.
 */
export async function runDuePlans(now = new Date()): Promise<{ ran: number; held: number }> {
  const rows = (await db('nivaro_ai_proposals')
    .where({ action_type: PLAN_ACTION_TYPE, status: 'scheduled' })
    .select('id', 'user', 'status', 'payload', 'created_at', 'executed_at')) as Array<
    Record<string, unknown>
  >
  let ran = 0
  let held = 0
  for (const row of rows) {
    const id = String(row.id)
    const doc = parseDoc(row.payload)
    const due = doc.schedule?.run_at ? new Date(doc.schedule.run_at).getTime() : 0
    if (!due || due > now.getTime()) continue
    const claimed = await db('nivaro_ai_proposals')
      .where({ id, status: 'scheduled' })
      .update({ status: 'running' })
    if (Number(claimed) !== 1) continue
    const user = await owner(row)
    if (!user) {
      await hold(id, row, doc, 'the person who scheduled it can no longer sign in')
      held++
      continue
    }
    const check = await recheckPendingSteps(user, doc)
    if (check.broken || check.changed.length > 0) {
      const reason = check.broken
        ? `step ${check.broken.n} no longer builds (${check.broken.error})`
        : `the records ${check.changed.length === 1 ? `step ${check.changed[0]}` : `steps ${check.changed.join(', ')}`} would act on changed since it was approved`
      await hold(id, row, doc, reason)
      held++
      continue
    }
    // Same records as approved — run on the payloads just rebuilt.
    await db('nivaro_ai_proposals')
      .where({ id })
      .update({ payload: JSON.stringify(doc) })
    await logActivity({
      action: 'ai-plan-run',
      user: user.id,
      comment: `plan ${id}: scheduled run, all remaining steps`
    })
    ran++
    void executePlan(user, id, doc, null).catch((err) => {
      getApp()?.log?.error({ err, plan: id }, 'Scheduled AI plan run failed')
    })
  }
  return { ran, held }
}
