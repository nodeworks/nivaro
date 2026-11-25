import { type ChecklistClaim, ChecklistError, checklistGate } from '../changes/checklist.js'
import { moveOpenMessage, openMoveFor } from '../move-open.js'
import { envPolicy } from '../owner-access.js'
import { appOfEnvironment, freezeRefusal, freezeUnknown } from '../releases/freeze.js'

/**
 * Hub config promotion: what may stop an apply or an undo now. Each answers a refusal
 * ({status, code, message}) or null, failing CLOSED where the underlying check does. The apply
 * runs them INSIDE the environment lock (a move or a freeze created a moment earlier is seen).
 *
 *  - an open move of the target (MOVE_OPEN): never, apply or undo;
 *  - freeze windows and deploy windows: THE change engine (services/hub/releases/freeze.ts
 *    freezeRefusal, action `config_promote`, judged for this environment so production-only
 *    windows apply). An administrator's emergency start outside the window (outside_window_reason,
 *    services/hub/changes/emergency.ts) skips the windows only; freezes still refuse;
 *  - the pre-deploy checklist (services/hub/changes/checklist.ts, action `config_promote`, one
 *    checklist per promotion: version `config-promotion-<id>`), claimed and linked as run kind
 *    `config`;
 *  - an UNDO puts back exactly the rows its promotion wrote: freezes and windows never stop it
 *    (reverting bad config during an incident is wanted) — it is an administrator's, on their own
 *    session, with a typed confirm (routes/hub-config.ts), and still refused while a move is open;
 *  - production: the ONE production rule (services/hub/owner-access.ts envPolicy).
 */

export interface GateRefusal {
  status: number
  code: string
  message: string
  extra?: Record<string, unknown>
}

export type ConfigAction = 'config_apply' | 'config_undo'

export async function moveOpenGate(envId: number): Promise<GateRefusal | null> {
  try {
    const m = await openMoveFor({ envIds: [envId] })
    return m ? { status: 409, code: 'MOVE_OPEN', message: moveOpenMessage(m) } : null
  } catch {
    return {
      status: 503,
      code: 'MOVE_UNKNOWN',
      message: 'The Hub could not tell whether a move of this environment is open — try again.'
    }
  }
}

/**
 * Freeze windows and deploy windows for an apply (action `config_promote`); null for an undo.
 * `skipWindows` = an administrator's emergency start outside the window.
 */
export async function changeWindowRefusal(
  envId: number,
  action: ConfigAction,
  o: { skipWindows?: boolean } = {}
): Promise<GateRefusal | null> {
  if (action === 'config_undo') return null
  let appId: number | null
  try {
    appId = await appOfEnvironment(envId)
  } catch {
    const u = freezeUnknown()
    return { status: u.status, code: u.code, message: u.message }
  }
  if (appId == null) return null
  const r = await freezeRefusal({
    appIds: [appId],
    action: 'config_promote',
    envId,
    ...(o.skipWindows ? { skipWindows: true } : {})
  })
  return r
    ? { status: r.status, code: r.code, message: r.message, extra: { freeze: r.freeze } }
    : null
}

/** The checklist version one promotion is ticked for (the admin panel builds the same string). */
export const checklistVersionOf = (promotionId: number) => `config-promotion-${promotionId}`

/** Claims the production pre-deploy checklist of this apply (null = none applies). */
export async function claimChecklist(
  envId: number,
  promotionId: number,
  runId: unknown
): Promise<ChecklistClaim | null> {
  try {
    return await checklistGate({
      target: { kind: 'environment', envId },
      action: 'config_promote',
      version: checklistVersionOf(promotionId),
      runId
    })
  } catch (e) {
    if (e instanceof ChecklistError) throw Object.assign(e, { checklist: true })
    throw e
  }
}

/** Whether the environment counts as production now (unknown = production: fails closed). */
export async function isProductionTarget(envId: number): Promise<boolean> {
  try {
    const p = await envPolicy(envId)
    return p ? p.production : true
  } catch {
    return true
  }
}
