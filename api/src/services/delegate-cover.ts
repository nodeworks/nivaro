import { db } from '../db/index.js'
import { whereInList } from './db-batch.js'
import {
  coerceBool,
  type OwnerResolutionTrace,
  resolveStateOwnersBatch
} from './pipeline-engine.js'

/**
 * "You're covering for Jane today — 4 of Jane's records need you" (rt5 #15).
 *
 * The delegate's view of a cover: who has named them their delegate and is out right now (the
 * resolver's own rule — out of office, delegate set, not expired), and how many of the records
 * waiting on the delegate reach them ONLY because of that cover. A record the delegate owns in
 * their own right is not counted: it would need them anyway.
 *
 * Cheap when nobody is out with this person as their delegate (one indexed read, nothing else).
 * Only for a covering delegate does it resolve their owned records (the same resolver My Work
 * uses) and re-resolve just those records with a trace, to see whose seat each one came through.
 *
 * Answers names of the people covered (out-of-office state is org-visible, like the chip every
 * avatar shows) and record KEYS of records already in the delegate's own My Work — no labels or
 * values beyond what My Work itself shows them.
 */

export interface CoverLine {
  user_id: string
  name: string
  first_name: string | null
  /** When the cover ends (the delegation's expiry), or null = until they are back. */
  ends_at: string | null
  /** Records waiting on the delegate only because of this cover. */
  records: number
  /** `collection:item` of those records (capped), for My Work's "Show them". */
  keys: string[]
}

export interface DelegatorRow {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  is_out_of_office: unknown
  delegate_id: string | null
  delegate_expires_at: Date | string | null
}

const MAX_PEOPLE = 10
const MAX_KEYS = 200

/** The resolver's rule (pipeline-engine buildDelegationSubstitutions): out, delegate set, not expired. */
export function delegationInForce(u: DelegatorRow, now: Date = new Date()): boolean {
  if (!coerceBool(u.is_out_of_office) || !u.delegate_id) return false
  if (!u.delegate_expires_at) return true
  const t = new Date(u.delegate_expires_at).getTime()
  return Number.isFinite(t) && t > now.getTime()
}

const up = (v: unknown) => String(v ?? '').toUpperCase()

/**
 * Per covered person (upper-cased id), the records whose owners came to `me` through a
 * substitution from them — and where `me` is not an owner in my own right. Pure.
 */
export function coveredRecords(
  traces: Map<
    string,
    Pick<OwnerResolutionTrace, 'groupOwners' | 'instanceOwners' | 'standIn' | 'substitutions'>
  >,
  me: string,
  coveredIds: Iterable<string>
): Map<string, string[]> {
  const meU = up(me)
  const wanted = new Set([...coveredIds].map(up))
  const out = new Map<string, string[]>()
  for (const [key, t] of traces) {
    const own = [...t.groupOwners, ...t.instanceOwners, ...t.standIn].some((o) => up(o.id) === meU)
    if (own) continue
    const from = new Set(
      t.substitutions
        .filter((s) => up(s.to.id) === meU && wanted.has(up(s.from.id)))
        .map((s) => up(s.from.id))
    )
    for (const f of from) {
      const list = out.get(f) ?? []
      list.push(key)
      out.set(f, list)
    }
  }
  return out
}

export interface CoverDeps {
  delegators: (userId: string) => Promise<DelegatorRow[]>
  owned: (userId: string) => Promise<Array<{ collection: string; item: string }>>
  instances: (
    owned: Array<{ collection: string; item: string }>
  ) => Promise<
    Array<{ instance_id: string; collection: string; item: string; current_state: string }>
  >
  traces: (
    requests: Array<{
      key: string
      stateId: string
      instanceId: string
      collection: string
      itemId: string
    }>
  ) => Promise<Map<string, OwnerResolutionTrace>>
  now: () => Date
}

const defaults: CoverDeps = {
  delegators: async (userId) =>
    (await db('nivaro_users')
      .where('delegate_id', userId)
      .where('is_out_of_office', true)
      .limit(50)
      .select(
        'id',
        'first_name',
        'last_name',
        'email',
        'is_out_of_office',
        'delegate_id',
        'delegate_expires_at'
      )) as DelegatorRow[],
  owned: async (userId) => {
    const { resolveOwnedByMeSource } = await import('./queues.js')
    const r = await resolveOwnedByMeSource(userId)
    return r.items.map((i) => ({ collection: i.collection, item: String(i.item_id) }))
  },
  instances: async (owned) => {
    const byCol = new Map<string, string[]>()
    for (const o of owned) byCol.set(o.collection, [...(byCol.get(o.collection) ?? []), o.item])
    const rows = await Promise.all(
      [...byCol].map(([collection, items]) =>
        whereInList(
          db('nivaro_workflow_instances')
            .where('collection', collection)
            .whereNull('completed_at')
            .whereNotNull('current_state'),
          'item',
          items
        ).select('id as instance_id', 'collection', 'item', 'current_state')
      )
    )
    return rows.flat() as Array<{
      instance_id: string
      collection: string
      item: string
      current_state: string
    }>
  },
  traces: async (requests) => {
    const trace = new Map<string, OwnerResolutionTrace>()
    await resolveStateOwnersBatch(requests, db, { trace })
    return trace
  },
  now: () => new Date()
}

const nameOf = (u: DelegatorRow) =>
  [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email || 'A colleague'

/** Who the person is covering for right now, and what of theirs waits on them. */
export async function coverFor(userId: string, deps: CoverDeps = defaults): Promise<CoverLine[]> {
  const now = deps.now()
  const people = (await deps.delegators(userId))
    .filter((u) => up(u.delegate_id) === up(userId) && up(u.id) !== up(userId))
    .filter((u) => delegationInForce(u, now))
    .slice(0, MAX_PEOPLE)
  if (people.length === 0) return []

  const owned = await deps.owned(userId)
  let covered = new Map<string, string[]>()
  if (owned.length > 0) {
    const inst = await deps.instances(owned)
    const requests = inst.map((i) => ({
      key: `${i.collection}:${i.item}`,
      stateId: String(i.current_state),
      instanceId: String(i.instance_id),
      collection: i.collection,
      itemId: String(i.item)
    }))
    if (requests.length > 0) {
      const traces = await deps.traces(requests)
      covered = coveredRecords(
        traces,
        userId,
        people.map((p) => p.id)
      )
    }
  }
  return people
    .map((p) => {
      const keys = [...new Set(covered.get(up(p.id)) ?? [])]
      return {
        user_id: String(p.id),
        name: nameOf(p),
        first_name: p.first_name?.trim() || null,
        ends_at: p.delegate_expires_at ? new Date(p.delegate_expires_at).toISOString() : null,
        records: keys.length,
        keys: keys.slice(0, MAX_KEYS)
      }
    })
    .sort((a, b) => b.records - a.records || a.name.localeCompare(b.name))
}
