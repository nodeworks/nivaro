import type { Knex } from 'knex'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { applyRowFilter, getRowFilter } from './permissions.js'
import {
  applyScopeEnforcement,
  getUserScopeEnforcement,
  type ScopeEnforcement
} from './user-scopes.js'

/**
 * Row access on queue reads.
 *
 * A queue lists records of its source collections. The list used to check
 * that the viewer may read the COLLECTION and nothing more: a person limited
 * to one zone by a user scope, or to their own rows by a role's row filter,
 * saw every record the queue matched — label, state, owners — and only met
 * the limit when opening one. The worklist seeded scope filters in the
 * browser, which is a convenience, not a boundary.
 *
 * A gate is compiled per (viewer, source collection). A viewer with nothing
 * to enforce produces no gate at all, so their queries are unchanged.
 */
export interface QueueGate {
  collection: string
  /** A strict scope the collection cannot be routed to: nothing is visible. */
  deny: boolean
  rowFilter: unknown | null
  scopes: ScopeEnforcement
}

export async function queueGateFor(user: User, collection: string): Promise<QueueGate | null> {
  const [rowFilter, scopes] = await Promise.all([
    getRowFilter(user, 'read', collection).catch(() => null),
    getUserScopeEnforcement(user, collection)
  ])
  if (!rowFilter && !scopes.deny && scopes.filters.length === 0) return null
  return { collection, deny: scopes.deny, rowFilter: rowFilter ?? null, scopes }
}

/** Gates for every collection-type source of a queue; open collections are left out. */
export async function queueGatesFor(user: User, queueId: string): Promise<QueueGate[]> {
  const rows = (await db('nivaro_queue_sources')
    .where({ queue_id: queueId, type: 'collection' })
    .whereNotNull('collection')
    .distinct('collection')) as Array<{ collection: string }>
  const collections = [...new Set(rows.map((r) => String(r.collection)))]
  const gates = await Promise.all(collections.map((c) => queueGateFor(user, c)))
  return gates.filter((g): g is QueueGate => g !== null)
}

/** Narrow a query whose base table IS the source collection. */
export function applyQueueGate(q: Knex.QueryBuilder, gate: QueueGate | null, user: User): void {
  if (!gate) return
  if (gate.deny) {
    void q.whereRaw('1 = 0')
    return
  }
  if (gate.rowFilter) applyRowFilter(q, gate.rowFilter as never, user)
  applyScopeEnforcement(q, gate.collection, gate.scopes)
}

/**
 * Narrow a query over the materialized cache (`nivaro_queue_items as qi`):
 * rows of a gated collection stay only when their record passes the gate.
 */
export function applyQueueGatesToCache(qb: Knex.QueryBuilder, gates: QueueGate[], user: User): void {
  for (const gate of gates) {
    if (gate.deny) {
      void qb.whereNot('qi.collection', gate.collection)
      continue
    }
    const visible = db(gate.collection).select(
      db.raw('CAST(??.?? AS NVARCHAR(255))', [gate.collection, 'id'])
    )
    applyQueueGate(visible, gate, user)
    void qb.where(function (this: Knex.QueryBuilder) {
      void this.whereNot('qi.collection', gate.collection).orWhereIn('qi.item_id', visible)
    })
  }
}
