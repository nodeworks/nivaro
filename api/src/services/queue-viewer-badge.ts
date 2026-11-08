import { db } from '../db/index.js'
import type { User } from '../types.js'
import { accessSigFor } from './queue-snapshot-access.js'
import { isUnowned, type QueueItem, type QueueRow } from './queues.js'
import { compileAccessGates, visibleIds } from './record-access.js'
import { currentTenantKey } from './tenant-rooms.js'

// Badge counts of a LIVE worklist for a viewer whose User Scope differs from the queue
// owner's (army 11 Q2-7 follow-up, coordinator: "no unbounded live reads per viewer").
//
// The owner's whole live item set is resolved ONCE per tenant + queue and kept for a
// minute (shared by every viewer, single-flight while it resolves); each viewer's figure
// is that set filtered through THEIR OWN record access — one batched visibility read per
// source collection, never a live resolve of their own. Only valid when the owner is
// unrestricted (the set then holds everything a viewer could see); otherwise null.

const TTL_MS = 60_000
const MAX_ENTRIES = 200

interface OwnerSet {
  at: number
  items: Promise<QueueItem[] | null>
}
const ownerSets = new Map<string, OwnerSet>()

/** Test seam: forget cached owner sets. */
export function resetViewerBadgeCache(): void {
  ownerSets.clear()
}

type Resolver = (queueId: string, owner: User) => Promise<QueueItem[]>

async function ownerItems(
  queue: Pick<QueueRow, 'id' | 'owner'>,
  resolve: Resolver
): Promise<QueueItem[] | null> {
  const key = `${currentTenantKey() ?? ''}|${String(queue.id).toUpperCase()}`
  const now = Date.now()
  const hit = ownerSets.get(key)
  if (hit && now - hit.at < TTL_MS) return hit.items
  const items = (async () => {
    const owner = (await db('nivaro_users').where({ id: queue.owner }).first()) as User | undefined
    if (!owner) return null
    // The shared set is only a superset of every viewer's when nothing narrows the owner.
    if ((await accessSigFor(owner as never)) !== '[]') return null
    return resolve(String(queue.id), owner)
  })()
  if (ownerSets.size >= MAX_ENTRIES) ownerSets.clear()
  ownerSets.set(key, { at: now, items })
  items.catch(() => ownerSets.delete(key))
  return items
}

export interface ViewerBadge {
  total: number
  sla_breached: number
  unowned: number
  sla_warning: number
  by_state: Record<string, number>
}

/** The viewer's own counts of a live worklist, or null when they cannot be had cheaply. */
export async function liveBadgeForViewer(
  queue: Pick<QueueRow, 'id' | 'owner'>,
  viewer: User,
  isAdmin: boolean,
  resolve: Resolver
): Promise<ViewerBadge | null> {
  if (!queue.owner) return null
  const items = await ownerItems(queue, resolve).catch(() => null)
  if (!items) return null
  const byCollection = new Map<string, string[]>()
  for (const it of items) {
    const list = byCollection.get(it.collection) ?? []
    list.push(String(it.item_id))
    byCollection.set(it.collection, list)
  }
  const visible = new Set<string>()
  for (const [collection, ids] of byCollection) {
    const gates = await compileAccessGates(viewer, collection, { actingAdmin: isAdmin })
    for (const id of await visibleIds(gates, ids)) visible.add(`${collection}:${id}`)
  }
  const mine = items.filter((it) => visible.has(`${it.collection}:${it.item_id}`))
  const by_state: Record<string, number> = {}
  for (const it of mine) by_state[it.state ?? 'none'] = (by_state[it.state ?? 'none'] ?? 0) + 1
  return {
    total: mine.length,
    sla_breached: mine.filter((it) => it.sla_status === 'breached').length,
    sla_warning: mine.filter((it) => it.sla_status === 'warning').length,
    unowned: mine.filter((it) => isUnowned(it)).length,
    by_state
  }
}
