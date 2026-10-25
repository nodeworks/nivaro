import { db } from '../db/index.js'
import type { User } from '../types.js'
import { explainAccess, viewerSafeReasons } from './access-explain.js'
import { humanCollection, listPhrase, personName } from './access-words.js'
import { applyRowFilter, can, getRowFilter } from './permissions.js'
import { parseJson } from './pipeline-engine.js'
import { type AccessReason, checkTransitionOwner } from './record-access.js'

/**
 * #1867 — "Why?" for a refused read, save, delete or transition.
 *
 * Re-runs the same gates the refusing route runs, one at a time, for the
 * person who was refused — role policy, row filter, User Scopes (through
 * access-explain / record-access), the record's edit lock, and for a
 * transition its role list and owner-only rule — and names who can change
 * each one. Read-only by construction: it only asks the gates.
 *
 * Disclosure: the person learns their own role, filters and the lock
 * holder — all things the app already shows them elsewhere. A person who
 * cannot read the collection at all learns nothing about the record.
 */

export type DeniedAction = 'read' | 'update' | 'delete' | 'transition'

/** The transition is unknown or belongs to another workflow than the record's (→ 404). */
export class TransitionNotFoundError extends Error {
  constructor() {
    super('Transition not found for this record')
  }
}

export interface DeniedReason {
  type: AccessReason['type'] | 'lock' | 'transition_roles' | 'transition_owner' | 'transition_state'
  message: string
}

export interface WhoCanChange {
  kind: 'admins' | 'lock_holder' | 'owners' | 'roles'
  people: string[]
  message: string
}

export interface DeniedExplanation {
  allowed: boolean
  action: DeniedAction
  reasons: DeniedReason[]
  who_can_change: WhoCanChange[]
  summary: string
}

const ADMIN_FIX: AccessReason['type'][] = ['permission', 'row_filter', 'scope', 'scope_strict']

/** Up to five active people with an admin role — never machine accounts. */
async function adminNames(): Promise<string[]> {
  const base = () =>
    db('nivaro_users as u')
      .join('nivaro_roles as r', 'r.id', 'u.role')
      .where('r.admin_access', true)
      .where('u.status', 'active')
      .where((q) => void q.where('u.is_redacted', false).orWhereNull('u.is_redacted'))
      .orderBy('u.last_name')
      .limit(5)
      .select('u.first_name', 'u.last_name', 'u.email')
  const rows = (await base()
    .whereNull('u.account_kind')
    .catch(() => base().catch(() => []))) as Array<{
    first_name: string | null
    last_name: string | null
    email: string | null
  }>
  return rows.map(personName)
}

export function deniedSummary(action: DeniedAction, reasons: DeniedReason[]): string {
  const verb =
    action === 'read'
      ? 'see this record'
      : action === 'update'
        ? 'save changes to this record'
        : action === 'delete'
          ? 'delete this record'
          : 'make this move'
  // An edit lock is advisory (the form honours it; the API does not), so
  // it is context beside a refusal, never the refusal itself.
  const blocking = reasons.filter((r) => r.type !== 'lock')
  const lock = reasons.find((r) => r.type === 'lock')
  const lockTail = lock ? ` Also, ${lock.message.replace(/\.$/, '')}.` : ''
  if (blocking.length === 0)
    return lock
      ? `Nothing in your access stops you — but ${lock.message.replace(/\.$/, '')}.`
      : `Nothing stops you from being able to ${verb} now — try again.`
  return `You cannot ${verb}: ${listPhrase(
    blocking.map((r) => r.message.replace(/\.$/, '')),
    'and'
  )}.${lockTail}`
}

export async function explainDenied(
  user: User,
  isAdmin: boolean,
  opts: { collection: string; id: string; action: DeniedAction; transitionId?: string | null }
): Promise<DeniedExplanation> {
  const { collection, id, action } = opts
  const reasons: DeniedReason[] = []
  const label = humanCollection(collection)

  // 1. Can they see it at all (role read, row filter, scopes, existence)?
  // A non-admin hears only that the record is not visible to them and their
  // OWN limits — never the record's value on the dimension that hid it.
  const seen = await explainAccess(user, isAdmin, collection, id)
  const seenReasons = isAdmin ? seen.reasons : viewerSafeReasons(seen.reasons)
  for (const r of seenReasons) reasons.push({ type: r.type, message: r.message })
  const visible = seen.access

  if (
    visible &&
    !isAdmin &&
    (action === 'update' || action === 'delete' || action === 'transition')
  ) {
    // 2. Role policy for the action (a transition changes the record → update).
    const policyAction = action === 'delete' ? 'delete' : 'update'
    if (!(await can(user, policyAction, collection))) {
      reasons.push({
        type: 'permission',
        message: `Your role does not have permission to ${policyAction} ${label} records.`
      })
    } else {
      // 3. The row filter that applies to THAT action (may differ from read).
      const rf = await getRowFilter(user, policyAction, collection).catch(() => null)
      if (rf && rf.length > 0) {
        const q = db(collection).where(`${collection}.id`, id)
        applyRowFilter(q, rf, user)
        const passes = !!(await q.first(`${collection}.id`).catch(() => null))
        if (!passes)
          reasons.push({
            type: 'row_filter',
            message: `A row rule on your role lets you ${policyAction} only some ${label} records, and this one is not among them.`
          })
      }
    }
  }

  // 4. Someone else holds the edit lock.
  let lockHolder: string | null = null
  if (visible && action !== 'read') {
    const lock = (await db('nivaro_item_locks as l')
      .leftJoin('nivaro_users as u', 'u.id', 'l.user')
      .where({ 'l.collection': collection, 'l.item': String(id) })
      .where('l.expires_at', '>', new Date())
      .first('l.user', 'l.expires_at', 'u.first_name', 'u.last_name', 'u.email')
      .catch(() => null)) as
      | {
          user: string
          expires_at: Date
          first_name: string | null
          last_name: string | null
          email: string | null
        }
      | null
      | undefined
    if (lock && String(lock.user).toUpperCase() !== String(user.id).toUpperCase()) {
      lockHolder = personName(lock)
      const at = new Date(lock.expires_at).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit'
      })
      reasons.push({
        type: 'lock',
        message: `${lockHolder} is editing this record and holds its lock (it lapses around ${at} if they stop)`
      })
    }
  }

  // 5. Transition-specific rules.
  let requiredRoleNames: string[] = []
  let ownerNames: string[] = []
  if (visible && action === 'transition' && opts.transitionId) {
    const tx = (await db('nivaro_workflow_transitions')
      .where({ id: opts.transitionId })
      .first()
      .catch(() => null)) as
      | {
          template: string
          label: string
          from_state: string | null
          required_roles: string | null
          require_owner?: boolean | number | null
          allow_creator?: boolean | number | null
          auto_trigger?: boolean | number | null
        }
      | null
      | undefined
    // The transition must belong to a workflow this record runs (its main
    // pipeline or a branch) — otherwise the id names some other template's
    // rules and roles, which are none of this record's business.
    const instance = tx
      ? ((await db('nivaro_workflow_instances')
          .where({ collection, item: String(id), template: tx.template })
          .orderByRaw('CASE WHEN completed_at IS NULL THEN 0 ELSE 1 END')
          .orderBy('id', 'desc')
          .first('id', 'current_state')
          .catch(() => null)) as { id: string; current_state: string } | null | undefined)
      : null
    if (!tx || !instance) throw new TransitionNotFoundError()
    if (tx.auto_trigger === true || tx.auto_trigger === 1) {
      reasons.push({
        type: 'transition_state',
        message: `"${tx.label}" runs automatically and cannot be clicked`
      })
    }
    if (
      tx.from_state &&
      String(tx.from_state).toUpperCase() !== String(instance.current_state).toUpperCase()
    ) {
      reasons.push({
        type: 'transition_state',
        message: `"${tx.label}" does not start from the record's current step`
      })
    }
    const roles = (parseJson(tx.required_roles) as string[] | null) ?? []
    if (!isAdmin && roles.length > 0 && !(user.role && roles.includes(String(user.role)))) {
      const rows = (await db('nivaro_roles')
        .whereIn('id', roles)
        .select('name')
        .catch(() => [])) as Array<{ name: string }>
      requiredRoleNames = rows.map((r) => r.name)
      reasons.push({
        type: 'transition_roles',
        message: `"${tx.label}" is limited to ${listPhrase(requiredRoleNames, 'or') || 'other roles'}`
      })
    }
    if (!isAdmin && (tx.require_owner === true || tx.require_owner === 1)) {
      // The verdict is the transition route's own check; the owner list
      // only supplies the names of who CAN make the move.
      const full = ((await db('nivaro_users').where({ id: user.id }).first()) ?? user) as User
      const verdict = await checkTransitionOwner({
        user: full,
        isAdmin,
        collection,
        item: String(id),
        instanceId: String(instance.id),
        allowCreator: tx.allow_creator === true || tx.allow_creator === 1
      })
      if (!verdict.allowed) {
        const { explainRecordOwners } = await import('./owner-explain.js')
        const ex = await explainRecordOwners(collection, String(id)).catch(() => null)
        ownerNames = (ex?.owners ?? []).filter((o) => !o.unavailable).map((o) => o.name)
        reasons.push({ type: 'transition_owner', message: verdict.message })
      }
    }
  }

  // Who can change each thing.
  const who: WhoCanChange[] = []
  if (reasons.some((r) => ADMIN_FIX.includes(r.type as AccessReason['type']))) {
    const people = await adminNames()
    who.push({
      kind: 'admins',
      people,
      message: `An administrator can change your role's permissions or your access filters${
        people.length ? ` — for example ${listPhrase(people, 'or')}` : ''
      }. "Request access" sends them the record and the reason.`
    })
  }
  if (lockHolder)
    who.push({
      kind: 'lock_holder',
      people: [lockHolder],
      message: `${lockHolder} can release the lock, or you can ask to take over from the lock banner.`
    })
  if (ownerNames.length)
    who.push({
      kind: 'owners',
      people: ownerNames,
      message: `${listPhrase(ownerNames, 'or')} can make this move, or reassign the step.`
    })
  if (requiredRoleNames.length)
    who.push({
      kind: 'roles',
      people: requiredRoleNames,
      message: `People with the ${listPhrase(requiredRoleNames, 'or')} role can make this move; an administrator can change the transition's roles.`
    })

  return {
    allowed: reasons.every((r) => r.type === 'lock'),
    action,
    reasons,
    who_can_change: who,
    summary: deniedSummary(action, reasons)
  }
}
