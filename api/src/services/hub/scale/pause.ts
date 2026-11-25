import { db } from '../../../db/index.js'
import { INCIDENTS } from '../incident/store.js'
import { moveOpenRefusal } from '../move-open.js'
import {
  defaultPromoteLock,
  defaultSharedLock,
  lockHolderRefusal,
  type PromoteLock,
  type SharedLock,
  sharedLockRefusal
} from '../promote-lock.js'
import { freezeRefusal } from '../releases/freeze.js'
import { openRunOf } from './store.js'
import type { ScaleTarget } from './target.js'

/**
 * Nivaro Hub scaling: what stops a scale now. Reads only.
 *
 * Both manual and automatic changes wait while another action holds the stack (a promotion,
 * Apply now, restart, an upgrade of the shared deployment, a placement: the environment / shared
 * locks), while a move into or out of it is open (MOVE_OPEN), and while another scale of it runs.
 * Automatic scaling also pauses during a release freeze (the freeze windows of hub-enh/deploys)
 * and while an incident is open for one of its apps (incidentOpenFor) — a person may still scale
 * by hand then (the plan warns).
 */

export interface Pause {
  code: string
  text: string
}

/**
 * Whether an incident is open (hub-enh/incident, nivaro_hub_incidents status `open`) for any of
 * these apps: one opened for the whole app (environment_id null), or for one of these
 * environments. Fails CLOSED: incidents that cannot be read count as open, except on a database
 * with no incident table (behind migration 576).
 */
export async function incidentOpenFor(target: {
  appIds: number[]
  envIds: number[]
}): Promise<boolean> {
  const appIds = target.appIds.filter((n) => Number.isInteger(n) && n > 0)
  if (!appIds.length) return false
  try {
    if (!(await db.schema.hasTable(INCIDENTS))) return false
    const row = await db(INCIDENTS)
      .where({ status: 'open' })
      .whereIn('app_id', appIds)
      .where((q) => {
        q.whereNull('environment_id')
        if (target.envIds.length) q.orWhereIn('environment_id', target.envIds)
      })
      .first('id')
    return !!row
  } catch {
    return true
  }
}

export interface PauseDeps {
  envLock?: PromoteLock
  sharedLock?: SharedLock
  incidentOpen?: typeof incidentOpenFor
  /** The instant freezes are judged at (default now). */
  at?: number
  /** A run judging its own resume: it does not block itself. */
  exceptRunId?: number
}

/** Why the target cannot be changed now (blockers) and, for a person, what to know (warnings). */
export async function scalePauses(
  t: ScaleTarget,
  mode: 'manual' | 'auto',
  deps: PauseDeps = {}
): Promise<{ blockers: Pause[]; warnings: Pause[] }> {
  const blockers: Pause[] = []
  const warnings: Pause[] = []
  const envLock = deps.envLock ?? defaultPromoteLock()
  const sharedLock = deps.sharedLock ?? defaultSharedLock()

  const open = await openRunOf(t.kind, t.id)
  if (open && open.id !== deps.exceptRunId)
    blockers.push({
      code: 'SCALE_RUNNING',
      text: `Scale run ${open.id} of this stack is still running — wait for it to end.`
    })

  const move = await moveOpenRefusal(
    t.kind === 'shared' ? { sharedId: t.id } : { envIds: t.env_ids }
  )
  if (move) blockers.push({ code: move.code, text: move.message })

  const unreadable = 'The Hub cannot reach Redis to tell who holds'
  if (t.kind === 'shared') {
    try {
      const holder = await sharedLock.holder(t.id)
      if (holder) blockers.push({ code: 'BUSY', text: sharedLockRefusal(holder).message })
    } catch {
      blockers.push({ code: 'LOCK_UNAVAILABLE', text: `${unreadable} this deployment's lock.` })
    }
    const running = (await db('nivaro_hub_shared_deploys')
      .where({ shared_deployment_id: t.id, status: 'running' })
      .first('id')) as { id: number } | undefined
    if (running)
      blockers.push({
        code: 'BUSY',
        text: `Run ${running.id} of this shared deployment (an upgrade or rollback) is running.`
      })
  }
  for (const envId of t.kind === 'environment' ? t.env_ids : []) {
    const held = await envLock.held(envId)
    if (held === false) continue
    try {
      const h = (await envLock.holder?.(envId)) ?? null
      blockers.push({
        code: 'BUSY',
        text: lockHolderRefusal(h, {
          code: 'ENVIRONMENT_BUSY',
          message:
            held === 'unknown'
              ? 'the Hub cannot tell whether another action holds this environment'
              : 'another action holds this environment'
        }).message
      })
    } catch {
      blockers.push({ code: 'LOCK_UNAVAILABLE', text: `${unreadable} this environment's lock.` })
    }
  }

  const frozen = await freezeRefusal({ appIds: t.app_ids, action: 'apply', now: deps.at })
  if (frozen) {
    const p =
      frozen.code === 'FREEZE_UNKNOWN'
        ? { code: frozen.code, text: frozen.message }
        : { code: 'FROZEN', text: `A release freeze is on (${frozen.freeze.name}).` }
    if (mode === 'auto') blockers.push(p)
    else
      warnings.push({
        code: p.code,
        text: `${p.text} Automatic scaling pauses until it ends; a change by hand still runs.`
      })
  }
  const incident = await (deps.incidentOpen ?? incidentOpenFor)({
    appIds: t.app_ids,
    envIds: t.env_ids
  })
  if (incident) {
    const p = { code: 'INCIDENT_OPEN', text: 'An incident is open for this app.' }
    if (mode === 'auto') blockers.push(p)
    else
      warnings.push({
        code: 'INCIDENT_OPEN',
        text: `${p.text} Automatic scaling pauses until it closes; a change by hand still runs.`
      })
  }
  return { blockers, warnings }
}
