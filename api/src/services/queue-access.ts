import type { Knex } from 'knex'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { applyRowFilter, getRowFilter } from './permissions.js'
import { currentTenantKey } from './tenant-rooms.js'
import {
  applyScopeEnforcement,
  getUserScopeEnforcement,
  type ScopeEnforcement
} from './user-scopes.js'

/**
 * Who may open a queue at all (owner, administrator, or a shared queue open
 * to everyone or to the viewer's role). routes/queues.ts canReadQueue is this
 * for a request; the cache warm asks it for the person it reads as.
 */
export function canUserReadQueue(
  queue: { owner?: string | null; is_shared?: boolean | number | null; role_id?: string | null },
  user: Pick<User, 'id' | 'role'>,
  isAdmin: boolean
): boolean {
  if (isAdmin) return true
  if (queue.owner === user.id) return true
  if (!queue.is_shared) return false
  const userRole = user.role ?? null
  return queue.role_id === null || queue.role_id === userRole
}

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

// The cache stores every record id as NVARCHAR (item_id); a gate that casts
// the SOURCE's id to text to compare cannot use its primary key index, and
// the materialized read used to repeat that scan in each of ~30 queries — a
// person with a zone scope waited 15–46 s per worklist read (staging
// 2026-10-26). Now the cache's text id is converted to the source key's own
// type (a seek per cache row), and the visible cache rows are worked out ONCE
// per read; every query then filters on the cache's own key.

const PK_TYPES = new Set(['int', 'bigint', 'smallint', 'uniqueidentifier'])
const pkTypes = new Map<string, Promise<string | null>>()

/** The SQL type of a table's `id` when it is a number or uuid (null for a
 *  text key, which compares as text). Read once per tenant + table. */
export function pkSqlType(table: string): Promise<string | null> {
  const key = `${currentTenantKey()}|${table}`
  let hit = pkTypes.get(key)
  if (!hit) {
    hit = (
      db('INFORMATION_SCHEMA.COLUMNS')
        .where({ TABLE_NAME: table, COLUMN_NAME: 'id' })
        .first('DATA_TYPE as type') as Promise<{ type?: string } | undefined>
    )
      .then((r) => {
        const t = String(r?.type ?? '').toLowerCase()
        return PK_TYPES.has(t) ? t : null
      })
      .catch(() => {
        pkTypes.delete(key)
        return null
      })
    pkTypes.set(key, hit)
  }
  return hit
}

/** `<table>.id = <text expression>`, matched on the table's own key type. */
export function idMatchesText(table: string, textExpr: string, type: string | null): Knex.Raw {
  return type
    ? db.raw(`??.?? = TRY_CONVERT(${type}, ${textExpr})`, [table, 'id'])
    : db.raw(`CAST(??.?? AS NVARCHAR(255)) = ${textExpr}`, [table, 'id'])
}

/** Which cache rows a viewer may see, per gated collection: `deny` hides the
 *  collection's rows, `ids` lists the visible nivaro_queue_items ids. */
export type CacheVisibility = Array<
  { collection: string; deny: true } | { collection: string; ids: number[] }
>

/** One query per gated collection: the queue's cache rows of it whose record
 *  passes the viewer's gate. */
export async function cacheVisibilityFor(
  queueId: string,
  gates: QueueGate[],
  user: User
): Promise<CacheVisibility> {
  return Promise.all(
    gates.map(async (gate) => {
      if (gate.deny) return { collection: gate.collection, deny: true as const }
      const type = await pkSqlType(gate.collection)
      const passes = db(gate.collection)
        .where(idMatchesText(gate.collection, 'qi.item_id', type))
        .select(db.raw('1'))
      applyQueueGate(passes, gate, user)
      const rows = (await db('nivaro_queue_items as qi')
        .where({ 'qi.queue_id': queueId, 'qi.collection': gate.collection })
        .whereExists(passes)
        .select('qi.id')) as Array<{ id: number }>
      return { collection: gate.collection, ids: rows.map((r) => Number(r.id)) }
    })
  )
}

/** Narrow a query over the cache (`nivaro_queue_items as qi`) to what the
 *  viewer may see; other collections' rows are left alone. */
export function applyCacheVisibility(qb: Knex.QueryBuilder, visibility: CacheVisibility): void {
  for (const v of visibility) {
    if ('deny' in v) {
      void qb.whereNot('qi.collection', v.collection)
      continue
    }
    void qb.where(function (this: Knex.QueryBuilder) {
      void this.whereNot('qi.collection', v.collection).orWhereRaw(
        'qi.id IN (SELECT CAST([value] AS INT) FROM OPENJSON(?))',
        [JSON.stringify(v.ids)]
      )
    })
  }
}
