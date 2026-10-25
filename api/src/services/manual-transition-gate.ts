import type { FastifyBaseLogger } from 'fastify'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { checkTransitionOwner, TRANSITION_OWNER_REQUIRED } from './record-access.js'
import { evaluateTransitionRequirements } from './transition-requirements.js'
import { evaluateConditionRules, fetchRecordForConditions } from './workflow-conditions.js'

/**
 * The gates a person's transition passes before anything moves — ONE chain for
 * every manual path (the record panel's transition route, branch transitions,
 * bulk transition). Record access (assertInstanceAccess) and the double-fire
 * claim stay with the caller: access must run before the instance is even
 * looked up, and the claim right before the mutation.
 */

export const TRANSITION_COMMENT_REQUIRED = 'TRANSITION_COMMENT_REQUIRED'

export interface GateTransition {
  id: string
  from_state: string | null
  required_roles: string | null
  auto_trigger?: boolean | number | null
  require_owner?: boolean | number | null
  allow_creator?: boolean | number | null
  comment_mode?: string | null
  requirements?: string | null
  condition_rules?: string | null
}

export interface GateInstance {
  id: string
  current_state: string | null
  completed_at: Date | string | null
}

export interface TransitionRefusal {
  status: number
  body: Record<string, unknown>
}

const on = (v: unknown) => v === true || v === 1 || v === '1'

function rolesOf(raw: string | null): string[] | null {
  if (!raw) return null
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(v) ? (v as string[]) : null
  } catch {
    return null
  }
}

/** A transition whose comment_mode is 'required' needs a note with text in it. */
export function commentMissing(transition: Pick<GateTransition, 'comment_mode'>, comment: unknown) {
  if (String(transition.comment_mode ?? '').toLowerCase() !== 'required') return false
  return typeof comment !== 'string' || comment.trim() === ''
}

/**
 * Why this person may not run `transition` on `instance` now, or null when
 * every gate passes. Order matters: shape errors first, then who, then data.
 */
export async function manualTransitionRefusal(opts: {
  user: User | undefined
  isAdmin: boolean
  collection: string
  item: string
  instance: GateInstance
  transition: GateTransition
  comment?: string | null
  reviewed?: boolean
  log?: Pick<FastifyBaseLogger, 'warn'>
}): Promise<TransitionRefusal | null> {
  const { instance, transition, isAdmin } = opts
  const refuse = (status: number, error: string, extra: Record<string, unknown> = {}) => ({
    status,
    body: { error, ...extra }
  })

  // A completed instance refuses transitions — EXCEPT when the template
  // authors an escape hatch out of the terminal state the record sits in
  // (Uncancel: canceled → previous).
  if (instance.completed_at) {
    const escapes =
      String(transition.from_state ?? '').toUpperCase() ===
      String(instance.current_state ?? '').toUpperCase()
    if (!escapes) return refuse(400, 'Pipeline is already completed')
  }

  const fromOk = transition.from_state === null || transition.from_state === instance.current_state
  if (!fromOk) return refuse(400, 'Transition is not valid from the current state')

  // Automatic transitions belong to the engine — never user-executable.
  if (on(transition.auto_trigger)) {
    return refuse(400, 'Automatic transitions cannot be executed manually')
  }

  if (!isAdmin) {
    const roles = rolesOf(transition.required_roles)
    if (roles && roles.length > 0) {
      const userRole = opts.user?.role ?? null
      if (!userRole || !roles.includes(userRole)) {
        return refuse(403, 'You do not have permission for this transition')
      }
    }
  }

  // Owner-only (#794): the caller must own the current step of THIS instance —
  // delegates standing in for an out-of-office owner included, admins exempt.
  if (on(transition.require_owner)) {
    if (!opts.user) return refuse(403, 'Sign in to make this move.')
    const owner = await checkTransitionOwner({
      user: opts.user,
      isAdmin,
      collection: opts.collection,
      item: opts.item,
      instanceId: String(instance.id),
      allowCreator: on(transition.allow_creator)
    })
    if (!owner.allowed) {
      return refuse(403, owner.message, { code: TRANSITION_OWNER_REQUIRED })
    }
  }

  // The record panel keeps Confirm disabled until a note is typed; every other
  // caller (worklist bulk bar, board drag, API keys, MCP) is held to it here.
  if (commentMissing(transition, opts.comment)) {
    return refuse(422, 'A note is required for this move.', { code: TRANSITION_COMMENT_REQUIRED })
  }

  // Requirements: a data-entry gate takes priority over conditional branching.
  if (transition.requirements) {
    const blocking = await evaluateTransitionRequirements(
      db,
      transition.requirements,
      opts.item,
      opts.log,
      opts.collection,
      // The requirements dialog's own re-submit: the person just reviewed the
      // rows, so a `review_when` entry no longer asks again.
      { reviewed: opts.reviewed === true }
    )
    if (blocking)
      return { status: 422, body: { error: 'TRANSITION_REQUIREMENTS', requirements: blocking } }
  }

  // Conditional branching: re-read the record — the client's view may be stale.
  if (transition.condition_rules) {
    const record = await fetchRecordForConditions(opts.collection, opts.item, [
      transition.condition_rules
    ])
    if (!evaluateConditionRules(transition.condition_rules, record)) {
      return refuse(409, 'Transition conditions not met')
    }
  }

  return null
}
