import { db } from '../db/index.js'
import type { User } from '../types.js'
import { selectInChunks } from './db-batch.js'
import { resolveStateOwnersBatch } from './pipeline-engine.js'
import { ADDENDUM_COLLECTION } from './pipeline-subject.js'
import { QUEUE_SANITY_CEILING } from './queues.js'
import { compileAccessGates, visibleIds } from './record-access.js'

/**
 * Can a delegate open the approvals they would inherit? Delegation routes a
 * person's owned steps to their delegate, but the delegate's own User Scopes
 * and row filters still decide what they can open — a delegate outside the
 * owner's zones inherits records they can never act on (army 2026-10-25:
 * 12 approvals handed to someone who got "You can't view this record").
 */

export interface DelegateReach {
  /** Open records whose current step resolves `ownerId` as an owner. */
  owned: number
  /** …of which the delegate cannot open. */
  hidden: number
}

/** Open records (collection → item ids) whose current step `userId` owns —
 *  the same resolution countOwnedApprovals uses, delegation not applied. */
async function ownedRecords(userId: string): Promise<Map<string, string[]>> {
  const instances = (await db('nivaro_workflow_instances as wi')
    .leftJoin('nivaro_workflow_bindings as b', 'wi.collection', 'b.collection')
    .where((qb) => qb.whereNotNull('b.collection').orWhere('wi.collection', ADDENDUM_COLLECTION))
    .whereNotNull('wi.current_state')
    .whereNull('wi.completed_at')
    .orderBy('wi.id')
    .limit(QUEUE_SANITY_CEILING)
    .select('wi.id as instance_id', 'wi.collection', 'wi.item', 'wi.current_state')) as Array<{
    instance_id: string
    collection: string
    item: string
    current_state: string
  }>
  const out = new Map<string, string[]>()
  if (instances.length === 0) return out
  const owners = await resolveStateOwnersBatch(
    instances.map((i) => ({
      key: `${i.collection}\u0000${i.item}`,
      stateId: i.current_state,
      instanceId: i.instance_id,
      collection: i.collection,
      itemId: i.item
    })),
    db,
    { skipDelegation: true }
  )
  const me = userId.toUpperCase()
  for (const [key, set] of owners) {
    if (!set.some((o) => String(o.id).toUpperCase() === me)) continue
    const [collection, item] = key.split('\u0000')
    const list = out.get(collection) ?? []
    list.push(item)
    out.set(collection, list)
  }
  return out
}

/** Ids (of `ids` in `collection`) `user` can open; an addendum through its parent. */
async function openable(
  user: User,
  isAdmin: boolean,
  collection: string,
  ids: string[]
): Promise<Set<string>> {
  if (collection !== ADDENDUM_COLLECTION) {
    const gates = await compileAccessGates(user, collection, { actingAdmin: isAdmin })
    return visibleIds(gates, ids)
  }
  const rows = (await selectInChunks(ids, 2000, (chunk) =>
    db(ADDENDUM_COLLECTION).whereIn('id', chunk).select('id', 'parent_collection', 'parent_id')
  )) as Array<{ id: unknown; parent_collection: string; parent_id: unknown }>
  const out = new Set<string>()
  const byParent = new Map<string, typeof rows>()
  for (const r of rows)
    byParent.set(r.parent_collection, [...(byParent.get(r.parent_collection) ?? []), r])
  for (const [parentCollection, list] of byParent) {
    const seen = await openable(
      user,
      isAdmin,
      parentCollection,
      list.map((r) => String(r.parent_id))
    )
    for (const r of list) if (seen.has(String(r.parent_id))) out.add(String(r.id))
  }
  return out
}

/** How many of `ownerId`'s owned open records `delegateId` could not open. */
export async function delegateReach(ownerId: string, delegateId: string): Promise<DelegateReach> {
  const delegate = (await db('nivaro_users').where({ id: delegateId }).first()) as User | undefined
  const isAdmin = delegate?.role
    ? !!(await db('nivaro_roles').where({ id: delegate.role }).first('admin_access'))?.admin_access
    : false
  const owned = await ownedRecords(ownerId)
  let total = 0
  let hidden = 0
  for (const [collection, ids] of owned) {
    total += ids.length
    if (!delegate) {
      hidden += ids.length
      continue
    }
    const seen = await openable(delegate, isAdmin, collection, ids).catch(() => new Set<string>())
    hidden += ids.filter((i) => !seen.has(String(i))).length
  }
  return { owned: total, hidden }
}

/** The sentence a person reads before handing approvals to someone who can't see them. */
export function reachWarning(reach: DelegateReach, delegateName: string): string | null {
  if (reach.hidden === 0) return null
  return reach.hidden === reach.owned
    ? `${delegateName} cannot open any of the ${reach.owned} records you own approvals on, so nothing would move while you're out. Pick a delegate who works the same records.`
    : `${delegateName} cannot open ${reach.hidden} of the ${reach.owned} records you own approvals on — those wait for you while you're out.`
}
