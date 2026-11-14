import type { FastifyBaseLogger } from 'fastify'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { adminOnlyStateOf, adminOnlyTransitionsFor } from './edit-lock.js'
import { checkTransitionOwner, TRANSITION_OWNER_REQUIRED } from './record-access.js'
import { registeredTransitionRefusal } from './transition-checks.js'
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
export const ADMIN_ONLY_TRANSITION = 'ADMIN_ONLY_TRANSITION'

export interface GateTransition {
  id: string
  from_state: string | null
  to_state?: string | null
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
 * Post-approval lock (admin-only tier): a record resting in an admin-only state
 * lets only administrators run the moves the collection lists (Cancel Workflow,
 * send-backs). Judged by transition id against the record's own latest state,
 * so the same move stays open while the record is still being approved. Only
 * listed ids are refused — an escape hatch out of a terminal state is not
 * affected unless listed. Admins are never refused.
 */
export async function adminOnlyTransitionRefusal(opts: {
  isAdmin: boolean
  collection: string
  item: string
  transitionId: string
}): Promise<TransitionRefusal | null> {
  if (opts.isAdmin) return null
  const listed = await adminOnlyTransitionsFor(opts.collection)
  if (!listed.has(String(opts.transitionId).toUpperCase())) return null
  const state = await adminOnlyStateOf(opts.collection, opts.item)
  if (!state) return null
  return {
    status: 403,
    body: { error: adminOnlyMoveMessage(state.label || state.key), code: ADMIN_ONLY_TRANSITION }
  }
}

/** The post-approval lock's sentence — the refusal and the record page's disabled button. */
export function adminOnlyMoveMessage(stateLabel: string): string {
  return `Only administrators can make this move at ${stateLabel}. Use Request help to ask for a change.`
}

/**
 * Of `transitions`, the ones adminOnlyTransitionRefusal would refuse this
 * person now → the refusal's sentence (empty for administrators). The record's
 * state is read once, and only when a listed move is among them.
 */
export async function adminOnlyMoveMessages<T extends { id: unknown }>(opts: {
  isAdmin: boolean
  collection: string
  item: string
  transitions: T[]
}): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (opts.isAdmin || opts.transitions.length === 0) return out
  const listed = await adminOnlyTransitionsFor(opts.collection)
  const hit = opts.transitions.filter((t) => listed.has(String(t.id).toUpperCase()))
  if (hit.length === 0) return out
  const state = await adminOnlyStateOf(opts.collection, opts.item)
  if (!state) return out
  const message = adminOnlyMoveMessage(state.label || state.key)
  for (const t of hit) out.set(String(t.id), message)
  return out
}

/**
 * The moves on offer to a person, less the ones adminOnlyTransitionRefusal
 * would refuse them — for the lists that offer moves (the record panel, the
 * Command Center peek). The record's state is read once, and only when a
 * listed move is on offer.
 */
export async function withoutAdminOnlyMoves<T extends { id: unknown }>(opts: {
  isAdmin: boolean
  collection: string
  item: string
  transitions: T[]
}): Promise<T[]> {
  const { transitions } = opts
  if (opts.isAdmin || transitions.length === 0) return transitions
  const listed = await adminOnlyTransitionsFor(opts.collection)
  const isListed = (t: T) => listed.has(String(t.id).toUpperCase())
  if (!transitions.some(isListed)) return transitions
  if (!(await adminOnlyStateOf(opts.collection, opts.item))) return transitions
  return transitions.filter((t) => !isListed(t))
}

/**
 * Why this person may not run `transition` on `instance` now, or null when
 * every gate passes. Order matters: shape errors first, then who, then data.
 * `skipRequirements` / `skipComment`: the question asked while the move's own
 * requirements dialog saves its values (requirement-writes.ts) — those values
 * are what the requirements wait for, and the note rides the move itself.
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
  skipRequirements?: boolean
  skipComment?: boolean
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

  const adminOnly = await adminOnlyTransitionRefusal({
    isAdmin,
    collection: opts.collection,
    item: opts.item,
    transitionId: transition.id
  })
  if (adminOnly) return adminOnly

  // Extension veto (ctx.transitions.registerCheck), right after the admin-only gate.
  const vetoed = await registeredTransitionRefusal({
    collection: opts.collection,
    item: opts.item,
    transitionId: transition.id,
    fromState: instance.current_state,
    toState: transition.to_state ?? null,
    user: opts.user,
    isAdmin
  })
  if (vetoed) return vetoed

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
  if (opts.skipComment !== true && commentMissing(transition, opts.comment)) {
    return refuse(422, 'A note is required for this move.', { code: TRANSITION_COMMENT_REQUIRED })
  }

  // Requirements: a data-entry gate takes priority over conditional branching.
  if (transition.requirements && opts.skipRequirements !== true) {
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
