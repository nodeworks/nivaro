import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'

/**
 * #643 — "changed since you looked", for lists. A record carries a mark when
 * the viewer opened it before (a `nivaro_record_views` row) and someone ELSE
 * edited it, moved it through its pipeline, or commented on it after their
 * last open (`last_viewed_at`, which every open moves to now). A record the
 * viewer never opened carries no mark: every row would, and the mark would
 * mean nothing.
 *
 * Batched: three reads per page whatever its size, each joined to the
 * viewer's watermarks — never one read per row.
 */

export interface UnseenChange {
  /** Newest change by someone else after the viewer's last open (ISO). */
  changed_at: string
  /** Who made that newest change, when known. */
  by: string | null
  kinds: Array<'edit' | 'transition' | 'comment'>
}

export async function unseenChangesFor(
  userId: string,
  collection: string,
  ids: Array<string | number>
): Promise<Map<string, UnseenChange>> {
  const out = new Map<string, UnseenChange>()
  const keys = [...new Set(ids.map(String))].filter(Boolean)
  if (keys.length === 0) return out

  const note = (item: string, at: Date, by: string | null, kind: UnseenChange['kinds'][number]) => {
    const cur = out.get(item)
    const iso = new Date(at).toISOString()
    if (!cur) {
      out.set(item, { changed_at: iso, by, kinds: [kind] })
      return
    }
    if (!cur.kinds.includes(kind)) cur.kinds.push(kind)
    if (iso > cur.changed_at) {
      cur.changed_at = iso
      cur.by = by
    }
  }
  const name = (r: Record<string, unknown>) =>
    [r.first_name, r.last_name].filter(Boolean).join(' ') || (r.email as string | null) || null

  const [edits, moves, comments] = await Promise.all([
    selectInChunks(keys, 1500, (chunk) =>
      db('nivaro_activity as a')
        .join('nivaro_record_views as v', function () {
          this.on('v.collection', '=', 'a.collection').andOn('v.item_id', '=', 'a.item')
        })
        .leftJoin('nivaro_users as u', 'u.id', 'a.user')
        .where('v.user', userId)
        .where('a.collection', collection)
        .whereIn('a.item', chunk)
        .whereIn('a.action', ['create', 'update'])
        .whereRaw('a.[timestamp] > v.last_viewed_at')
        .where((b) => b.whereNull('a.user').orWhereNot('a.user', userId))
        .groupBy('a.item', 'u.first_name', 'u.last_name', 'u.email')
        .select('a.item', 'u.first_name', 'u.last_name', 'u.email')
        .max({ at: 'a.timestamp' })
    ),
    selectInChunks(keys, 1500, (chunk) =>
      db('nivaro_workflow_history as h')
        .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
        .join('nivaro_record_views as v', function () {
          this.on('v.collection', '=', 'i.collection').andOn('v.item_id', '=', 'i.item')
        })
        .leftJoin('nivaro_users as u', 'u.id', 'h.user')
        .where('v.user', userId)
        .where('i.collection', collection)
        .whereIn('i.item', chunk)
        .whereRaw('h.[timestamp] > v.last_viewed_at')
        .where((b) => b.whereNull('h.user').orWhereNot('h.user', userId))
        .groupBy('i.item', 'u.first_name', 'u.last_name', 'u.email')
        .select('i.item', 'u.first_name', 'u.last_name', 'u.email')
        .max({ at: 'h.timestamp' })
    ),
    selectInChunks(keys, 1500, (chunk) =>
      db('nivaro_comments as c')
        .join('nivaro_record_views as v', function () {
          this.on('v.collection', '=', 'c.collection').andOn('v.item_id', '=', 'c.item')
        })
        .leftJoin('nivaro_users as u', 'u.id', 'c.user')
        .where('v.user', userId)
        .where('c.collection', collection)
        .whereIn('c.item', chunk)
        .whereRaw('c.created_at > v.last_viewed_at')
        .whereNot('c.user', userId)
        .groupBy('c.item', 'u.first_name', 'u.last_name', 'u.email')
        .select('c.item', 'u.first_name', 'u.last_name', 'u.email')
        .max({ at: 'c.created_at' })
    )
  ])
  for (const r of edits as Array<Record<string, unknown>>)
    note(String(r.item), r.at as Date, name(r), 'edit')
  for (const r of moves as Array<Record<string, unknown>>)
    note(String(r.item), r.at as Date, name(r), 'transition')
  for (const r of comments as Array<Record<string, unknown>>)
    note(String(r.item), r.at as Date, name(r), 'comment')
  return out
}

/**
 * The same rule as a SQL predicate on `<alias>.id`, for the "Unseen changes"
 * filter: EXISTS over the three sources, each against the viewer's watermark.
 * Callers pass the query builder they are narrowing.
 */
export function whereUnseen(
  qb: Knex.QueryBuilder,
  alias: string,
  collection: string,
  userId: string
): Knex.QueryBuilder {
  return qb.where((outer) => {
    outer
      .whereExists(
        db('nivaro_record_views as v')
          .join('nivaro_activity as a', function () {
            this.on('a.collection', '=', 'v.collection').andOn('a.item', '=', 'v.item_id')
          })
          .where('v.user', userId)
          .where('v.collection', collection)
          .whereRaw('v.item_id = CAST(??.?? AS NVARCHAR(255))', [alias, 'id'])
          .whereIn('a.action', ['create', 'update'])
          .whereRaw('a.[timestamp] > v.last_viewed_at')
          .where((b) => b.whereNull('a.user').orWhereNot('a.user', userId))
          .select(db.raw('1'))
      )
      .orWhereExists(
        db('nivaro_record_views as v')
          .join('nivaro_workflow_instances as i', function () {
            this.on('i.collection', '=', 'v.collection').andOn('i.item', '=', 'v.item_id')
          })
          .join('nivaro_workflow_history as h', 'h.instance', 'i.id')
          .where('v.user', userId)
          .where('v.collection', collection)
          .whereRaw('v.item_id = CAST(??.?? AS NVARCHAR(255))', [alias, 'id'])
          .whereRaw('h.[timestamp] > v.last_viewed_at')
          .where((b) => b.whereNull('h.user').orWhereNot('h.user', userId))
          .select(db.raw('1'))
      )
      .orWhereExists(
        db('nivaro_record_views as v')
          .join('nivaro_comments as c', function () {
            this.on('c.collection', '=', 'v.collection').andOn('c.item', '=', 'v.item_id')
          })
          .where('v.user', userId)
          .where('v.collection', collection)
          .whereRaw('v.item_id = CAST(??.?? AS NVARCHAR(255))', [alias, 'id'])
          .whereRaw('c.created_at > v.last_viewed_at')
          .whereNot('c.user', userId)
          .select(db.raw('1'))
      )
  })
}
