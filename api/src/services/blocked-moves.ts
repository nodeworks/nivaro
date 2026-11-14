/**
 * Moves a person cannot make right now, said before they are pressed (Rob
 * 2026-11-13: FDX25INV-37713 sat in Warehouse Submission and its creator saw
 * only Send Back and Cancel — "Submit to Warehouse" had vanished because
 * nobody was an ASSIGNED owner of that step on the record).
 *
 * GET /pipelines/instance/:collection/:item answers `blocked_transitions`
 * beside `available_transitions` (which stays exactly as it was): the manual
 * moves from the record's current state whose condition rules MATCH this
 * record, that this caller may not run, each with the reason. The record page
 * draws them as disabled buttons with the reason as their tip; the list-row
 * menu never offers them.
 *
 * A move whose conditions do not apply to the record stays out entirely (the
 * Fusion variants on an MDSi warehouse): it is not "blocked", it is not this
 * record's move at all.
 *
 * Reasons, in the order the gate (manual-transition-gate.ts) asks:
 *   ADMIN_ONLY — the post-approval lock (adminOnlyMoveMessage, the refusal's words)
 *   ROLE       — the move's required roles, named
 *   OWNER      — owner-only and not an assigned owner (ownerOnlyMessage, the refusal's words)
 *   SKIPPED    — a send back to a step this record skips (noTargetMessage, the engine's words)
 */
import { listPhrase } from './access-words.js'
import { ownerOnlyMessage } from './record-access.js'
import { isSendBackMove, type SendBackStateRow } from './send-back-skips.js'
import { noTargetMessage } from './workflow-transitions.js'

export type MoveBlockCode = 'ROLE' | 'OWNER' | 'ADMIN_ONLY' | 'SKIPPED'

export interface MoveBlock {
  code: MoveBlockCode
  reason: string
}

export interface BlockableMove {
  id: unknown
  to_state: string
  to_previous?: unknown
  required_roles?: unknown
  require_owner?: unknown
  allow_creator?: unknown
}

const on = (v: unknown) => v === true || v === 1 || v === '1'
const up = (v: unknown) => String(v ?? '').toUpperCase()

/** The move's required role ids, or [] when it names none. */
export function requiredRoleIds(raw: unknown): string[] {
  let v = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return []
    }
  }
  return Array.isArray(v) ? v.map((r) => String(r)).filter(Boolean) : []
}

/** Does this role pass the move's role list (the panel's own case-blind test)? */
export function roleAllows(move: Pick<BlockableMove, 'required_roles'>, role: unknown): boolean {
  const roles = requiredRoleIds(move.required_roles)
  if (roles.length === 0) return true
  return role != null && roles.some((r) => up(r) === up(role))
}

/** "Only Admin can make this move." — role names, never ids. */
export function roleOnlyMessage(roleNames: string[]): string {
  const names = roleNames.map((n) => n.trim()).filter(Boolean)
  return names.length
    ? `Only ${listPhrase(names, 'or')} can make this move.`
    : "Your role can't make this move."
}

/**
 * Pure: the reason each candidate this caller may not run is held back, in
 * the gate's order. `candidates` = manual moves from the current state whose
 * conditions match the record. Moves in `offeredIds` are on offer and never
 * blocked. A move refused for a reason none of these name is left out (it is
 * neither offered nor explained — the old behaviour).
 */
export function blockedMoveReasons<T extends BlockableMove>(opts: {
  candidates: T[]
  offeredIds: Set<string>
  isAdmin: boolean
  role: string | null
  /** Role id → name, for the roles the candidates require. */
  roleNames: Map<string, string>
  /** The owner-only verdict for this caller, null when not judged (admins, a role preview). */
  actor: {
    is_owner: boolean
    is_creator: boolean
    step?: string | null
    owner_names?: string[] | null
  } | null
  /** Move id → the post-approval lock's sentence. */
  adminOnly: Map<string, string>
  /** Skipped send-back target state id → the engine's reasons. */
  skipped: Map<string, string[]>
  states: Array<SendBackStateRow & { label?: string | null }>
  currentStateId: string | null
}): Array<{ move: T; blocked: MoveBlock }> {
  const out: Array<{ move: T; blocked: MoveBlock }> = []
  const skippedUp = new Map([...opts.skipped].map(([id, reasons]) => [up(id), reasons]))
  for (const move of opts.candidates) {
    const id = String(move.id)
    if (opts.offeredIds.has(id)) continue
    const blocked = reasonFor(move)
    if (blocked) out.push({ move, blocked })
  }
  return out

  function reasonFor(move: T): MoveBlock | null {
    const lock = opts.adminOnly.get(String(move.id))
    if (lock) return { code: 'ADMIN_ONLY', reason: lock }
    if (!opts.isAdmin && !roleAllows(move, opts.role)) {
      const names = requiredRoleIds(move.required_roles)
        .map((r) => opts.roleNames.get(up(r)))
        .filter((n): n is string => !!n)
      return { code: 'ROLE', reason: roleOnlyMessage([...new Set(names)]) }
    }
    if (!opts.isAdmin && opts.actor && on(move.require_owner)) {
      const passes =
        opts.actor.is_owner || (on(move.allow_creator) && opts.actor.is_creator === true)
      if (!passes)
        return {
          code: 'OWNER',
          reason: ownerOnlyMessage({
            step: opts.actor.step ?? null,
            allowCreator: on(move.allow_creator),
            ownerNames: opts.actor.owner_names ?? null
          })
        }
    }
    const reasons = skippedUp.get(up(move.to_state))
    if (reasons && isSendBackMove(move, opts.states, opts.currentStateId)) {
      const target = opts.states.find((s) => up(s.id) === up(move.to_state))
      const noOwners = reasons.some((r) => /no owner/i.test(r))
      return {
        code: 'SKIPPED',
        reason: noTargetMessage(
          target?.label || 'That step',
          noOwners,
          reasons.find((r) => !/no owner/i.test(r)) ?? null
        )
      }
    }
    return null
  }
}
