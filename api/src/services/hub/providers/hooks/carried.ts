import { db } from '../../../../db/index.js'
import {
  type ChangeOrigin,
  type ChangePlan,
  type ChangeStatus,
  type HubActor,
  type PlanRequest,
  planCarriedResourceChange,
  ResourceChangeError,
  resumeResourceChange,
  startResourceChange
} from '../engine/contract.js'
import { readChange } from '../store.js'

/**
 * Task 11a: how the existing Hub flows (create app, promote, retire) use the provider framework.
 * Every write goes through the change engine (planCarriedResourceChange → startResourceChange →
 * the engine's run): this file only plans, starts or resumes ONE change for a flow's step and
 * waits for it to end, so the flow's own step stays idempotent:
 *
 *  - the step records the change id it planned (`onPlanned`) BEFORE starting it;
 *  - on a retry / resume the step hands that id back (`changeId`): an applied change is done, an
 *    applying one is waited for, an interrupted (or retryably failed) one is resumed, a planned
 *    one is started; anything else (stale, cancelled, declined, failed for good) is planned anew
 *    from the provider's current state (plans are diffs, so a create that already happened plans
 *    as a no-op).
 *
 * The flow passes the person it acts for (`actor`, never an agent: carried changes are writes)
 * and its own `origin` (the engine re-judges it at every plan, start and resume).
 */

/** The Hub person a run acts for: an active account; admin when its role has admin access. */
export async function hubActorForUser(userId: string | null): Promise<HubActor | null> {
  if (!userId) return null
  const u = (await db('nivaro_users').where({ id: userId }).first('id', 'status', 'role')) as
    | { id: string; status: string | null; role: string | null }
    | undefined
  if (!u || String(u.status ?? 'active') !== 'active') return null
  let isAdmin = false
  if (u.role) {
    const r = (await db('nivaro_roles').where({ id: u.role }).first('admin_access')) as
      | { admin_access?: unknown }
      | undefined
    isAdmin = r?.admin_access === true || r?.admin_access === 1 || r?.admin_access === '1'
  }
  return { id: String(u.id), isAdmin, via: 'session' }
}

export type CarriedOutcome =
  | { status: 'applied'; changeId: number }
  /** An owner's change that adds a monthly cost: a Hub admin approves it (the flow waits). */
  | { status: 'pending_approval'; changeId: number }
  /** The plan has blockers (SHARED_IN_USE, ALREADY_EXISTS…): nothing was started. */
  | { status: 'blocked'; changeId: number; code: string; message: string }
  | {
      status: 'failed' | 'interrupted' | 'cancelled'
      changeId: number
      code: string
      message: string
    }

export interface CarriedRun {
  req: PlanRequest
  actor: HubActor
  origin: ChangeOrigin
  /** The change an earlier try of this step planned (resume), or null. */
  changeId?: number | null
  /** Records a newly planned change's id before it starts (the step's own memory). */
  onPlanned?: (changeId: number) => Promise<void>
  /**
   * The flow's own typed confirmation covers this change (a retirement's typed app key): the
   * change's confirm text, if any, is sent for it. Otherwise a change that needs one is blocked.
   */
  confirmed?: boolean
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  /** How long to wait for an applying change (default 30 minutes). */
  deadlineMs?: number
  now?: () => number
}

const TERMINAL: readonly ChangeStatus[] = [
  'applied',
  'failed',
  'interrupted',
  'cancelled',
  'declined',
  'stale',
  'pending_approval'
]

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms)
    t.unref?.()
  })

function outcomeOf(changeId: number, status: ChangeStatus, code: string, message: string) {
  if (status === 'applied') return { status: 'applied' as const, changeId }
  if (status === 'pending_approval') return { status: 'pending_approval' as const, changeId }
  if (status === 'interrupted' || status === 'cancelled') return { status, changeId, code, message }
  return { status: 'failed' as const, changeId, code, message }
}

async function waitFor(changeId: number, o: CarriedRun): Promise<CarriedOutcome> {
  const sleep = o.sleep ?? defaultSleep
  const now = o.now ?? Date.now
  const until = now() + (o.deadlineMs ?? 30 * 60_000)
  for (;;) {
    const row = await readChange(changeId)
    if (!row)
      return { status: 'failed', changeId, code: 'NOT_FOUND', message: 'The change is gone.' }
    if (TERMINAL.includes(row.status))
      return outcomeOf(
        changeId,
        row.status,
        row.error_code ?? row.status.toUpperCase(),
        row.error ?? `The change ended ${row.status}.`
      )
    if (o.signal?.aborted)
      return {
        status: 'interrupted',
        changeId,
        code: 'ABORTED',
        message: 'The step stopped while its resource change was still applying.'
      }
    if (now() > until)
      return {
        status: 'interrupted',
        changeId,
        code: 'TIMEOUT',
        message: 'The resource change is still applying; the step waits for it on its next try.'
      }
    await sleep(o.pollMs ?? 5_000)
  }
}

function blockedOf(plan: ChangePlan): CarriedOutcome | null {
  const b = plan.blockers[0]
  return b ? { status: 'blocked', changeId: plan.changeId, code: b.code, message: b.message } : null
}

async function start(plan: ChangePlan, o: CarriedRun): Promise<CarriedOutcome> {
  const blocked = blockedOf(plan)
  if (blocked) return blocked
  if (plan.needsConfirm && !o.confirmed)
    return {
      status: 'blocked',
      changeId: plan.changeId,
      code: 'CONFIRM_MISMATCH',
      message: `This change needs its own typed confirmation (${plan.needsConfirm}): start it from the Hub's change view.`
    }
  try {
    const out = await startResourceChange(
      plan.changeId,
      { planHash: plan.planHash, ...(plan.needsConfirm ? { confirm: plan.needsConfirm } : {}) },
      o.actor
    )
    if (out.status === 'pending_approval')
      return { status: 'pending_approval', changeId: plan.changeId }
  } catch (e) {
    if (e instanceof ResourceChangeError)
      return { status: 'blocked', changeId: plan.changeId, code: e.code, message: e.message }
    throw e
  }
  return waitFor(plan.changeId, o)
}

/** Plans (or picks up) the step's change, starts it and waits for it to end. */
export async function runCarriedChange(o: CarriedRun): Promise<CarriedOutcome> {
  if (o.changeId != null) {
    const row = await readChange(Number(o.changeId))
    if (row) {
      const retryable =
        row.status === 'failed' &&
        [...row.steps].reverse().find((s) => s.status === 'failed')?.error?.retryable === true
      if (row.status === 'applied') return { status: 'applied', changeId: row.id }
      if (row.status === 'applying' || row.status === 'pending_approval') return waitFor(row.id, o)
      if (row.status === 'interrupted' || retryable) {
        try {
          await resumeResourceChange(row.id, o.actor)
        } catch (e) {
          if (e instanceof ResourceChangeError)
            return { status: 'blocked', changeId: row.id, code: e.code, message: e.message }
          throw e
        }
        return waitFor(row.id, o)
      }
      if (row.status === 'planned' && row.plan) {
        const plan: ChangePlan = {
          changeId: row.id,
          planHash: row.plan_hash ?? '',
          status: row.status,
          ops: row.plan.ops,
          gates: row.plan.gates,
          needsConfirm: row.plan.needsConfirm,
          needsApproval: row.plan.needsApproval,
          blockers: row.plan.blockers
        }
        const out = await start(plan, o)
        // A stale plan (the provider moved): plan again below.
        if (!(out.status === 'blocked' && out.code === 'STALE_PLAN')) return out
      }
    }
  }
  let plan: ChangePlan
  try {
    plan = await planCarriedResourceChange(o.req, o.actor, o.origin)
  } catch (e) {
    if (e instanceof ResourceChangeError)
      return { status: 'blocked', changeId: 0, code: e.code, message: e.message }
    throw e
  }
  await o.onPlanned?.(plan.changeId)
  return start(plan, o)
}
