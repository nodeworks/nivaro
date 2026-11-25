import { moveOpenMessage, openMoveFor } from '../move-open.js'
import { envPolicy } from '../owner-access.js'
import { environmentFreezeRefusal } from '../releases/freeze.js'

/**
 * Hub config promotion: what may stop an apply or an undo now. Each answers a refusal
 * ({status, code, message}) or null, and fails CLOSED where the underlying check does.
 *
 *  - an open move of the target (MOVE_OPEN): never, apply or undo — the move relies on the
 *    environment as it is;
 *  - a freeze window (hub-enh/deploys, services/hub/releases/freeze.ts, action `promote`): stops
 *    an apply; an UNDO puts back exactly what was there before the promotion (a true rollback to
 *    the last known good), so a freeze never stops it;
 *  - a change window (idea 27, built in parallel on hub-enh/change): changeWindowRefusal below is
 *    the ONE seam — that branch replaces its body with its deploy-window engine (one rule engine,
 *    not two); undo is exempt there too (rollbacks always allowed).
 *  - production: the ONE production rule (services/hub/owner-access.ts envPolicy) decides whether
 *    the person must type the environment's key.
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

export async function freezeGate(envId: number, action: ConfigAction): Promise<GateRefusal | null> {
  if (action === 'config_undo') return null
  const r = await environmentFreezeRefusal(envId, 'promote')
  return r
    ? { status: r.status, code: r.code, message: r.message, extra: { freeze: r.freeze } }
    : null
}

/**
 * THE seam for change windows (idea 27): null = allowed now. hub-enh/change answers its window
 * refusal here for `config_apply` (and lets `config_undo` through).
 */
export async function changeWindowRefusal(
  _envId: number,
  _action: ConfigAction
): Promise<GateRefusal | null> {
  return null
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
