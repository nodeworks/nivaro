import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import { tenantState } from '../ai-tenant-state.js'
import { compileAccessGates, visibleIds } from '../record-access.js'
import { DAY_MS, isSystemCollection } from './model.js'

/**
 * "My records" — the records a person owns, created or follows, for the Overview's activity
 * scope and its "changed on records you follow" line:
 *
 *   owns     — records whose current pipeline state resolves them as an owner (the same
 *              owned-by-me resolver My Work uses), time-boxed so a slow resolution never holds
 *              the page
 *   created  — their own `create` activity over the last 180 days (newest 400)
 *   follows  — the records they starred (nivaro_pinned_items)
 *
 * Every record is then judged AS THE PERSON (role policy, row filters, User Scopes): the set
 * never names a record they cannot read, so reading its activity grants nothing new.
 */

export const MY_RECORDS_CAP = 600
const CREATED_DAYS = 180
const CREATED_CAP = 400
const OWNED_BUDGET_MS = 2500
const CACHE_MS = 60_000

export type RecordSet = Map<string, Set<string>>

const cache = tenantState(() => new Map<string, { at: number; set: RecordSet }>())

function add(set: RecordSet, collection: unknown, item: unknown): void {
  const c = typeof collection === 'string' ? collection : ''
  if (isSystemCollection(c) || item == null || item === '') return
  let ids = set.get(c)
  if (!ids) {
    ids = new Set()
    set.set(c, ids)
  }
  ids.add(String(item))
}

export function recordCount(set: RecordSet): number {
  let n = 0
  for (const ids of set.values()) n += ids.size
  return n
}

async function ownedRecords(userId: string): Promise<Array<{ collection: string; item: string }>> {
  try {
    const { resolveOwnedByMeSource } = await import('../queues.js')
    const result = await Promise.race([
      resolveOwnedByMeSource(userId),
      new Promise<null>((r) => setTimeout(() => r(null), OWNED_BUDGET_MS).unref?.())
    ])
    return (result?.items ?? []).map((i) => ({ collection: i.collection, item: String(i.item_id) }))
  } catch {
    return []
  }
}

export async function myRecordSet(
  user: User,
  opts: { isAdmin: boolean; now?: Date }
): Promise<RecordSet> {
  const key = `${user.id}|${opts.isAdmin ? 'a' : 'u'}`
  const hit = cache().get(key)
  const now = opts.now ?? new Date()
  if (hit && now.getTime() - hit.at < CACHE_MS) return hit.set

  const [owned, created, pinned] = await Promise.all([
    ownedRecords(String(user.id)),
    db('nivaro_activity')
      .where({ user: user.id, action: 'create' })
      .whereNotNull('item')
      .where('timestamp', '>=', new Date(now.getTime() - CREATED_DAYS * DAY_MS))
      .orderBy('timestamp', 'desc')
      .limit(CREATED_CAP)
      .select('collection', 'item')
      .catch(() => []) as Promise<Array<{ collection: string; item: string }>>,
    db('nivaro_pinned_items')
      .where({ user: user.id })
      .orderBy('id', 'desc')
      .limit(200)
      .select('collection', 'item_id as item')
      .catch(() => []) as Promise<Array<{ collection: string; item: string }>>
  ])

  const raw: RecordSet = new Map()
  for (const r of [...owned, ...pinned, ...created]) {
    if (recordCount(raw) >= MY_RECORDS_CAP) break
    add(raw, r.collection, r.item)
  }

  // Judge every record as the person; an admin's set is taken as it stands.
  const set: RecordSet = new Map()
  for (const [collection, ids] of raw) {
    const list = [...ids]
    let ok: Set<string>
    if (opts.isAdmin) ok = new Set(list)
    else {
      try {
        const gates = await compileAccessGates(user, collection)
        ok = await visibleIds(gates, list)
      } catch {
        ok = new Set()
      }
    }
    if (ok.size) set.set(collection, ok)
  }
  cache().set(key, { at: now.getTime(), set })
  if (cache().size > 2000) cache().clear()
  return set
}

/**
 * Narrow a query over `nivaro_activity as <alias>` to the set: one (collection AND item IN …)
 * group per collection, every value bound. An empty set matches nothing.
 */
export function whereInRecordSet<Q extends { where: (...a: any[]) => Q }>(
  qb: Q,
  set: RecordSet,
  alias = 'a'
): Q {
  if (set.size === 0) return qb.where(db.raw('1 = 0')) as Q
  return qb.where((outer: any) => {
    for (const [collection, ids] of set) {
      outer.orWhere((g: any) => {
        g.where(`${alias}.collection`, collection).whereIn(`${alias}.item`, [...ids])
      })
    }
  })
}
