import { db } from '../db/index.js'
import type { User } from '../types.js'
import { getEncryptedFields } from './encryption.js'
import { can, getAllowedFields } from './permissions.js'
import { isSystemCollection } from './system-collections.js'

/**
 * #2706 "Repeat last value": the value THIS person last entered for a field
 * on a record of the collection, read from their own revisions — the
 * newest create or update by them that set the field to something. Never
 * another person's value, never a system or encrypted column.
 */

/** Activity rows looked at, newest first: one person's last few saves here. */
const SCAN = 40

export type LastValueRefusal = { status: 400 | 403; error: string }

export interface LastValue {
  value: unknown
  item: string
  at: string | null
}

const FIELD_RE = /^[A-Za-z0-9_]{1,64}$/

const parse = (v: unknown): Record<string, unknown> | null => {
  if (v && typeof v === 'object') return v as Record<string, unknown>
  if (typeof v !== 'string' || !v) return null
  try {
    const p = JSON.parse(v)
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const empty = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

/** The value a revision says this save set for `field`, or undefined. */
export function valueSetBy(
  action: string,
  rev: { data?: unknown; delta?: unknown },
  field: string
): unknown {
  // An update's delta holds exactly what that save changed; a create sets the row.
  const src = parse(action === 'create' ? (rev.data ?? rev.delta) : rev.delta)
  if (!src || !(field in src)) return undefined
  const v = src[field]
  return empty(v) ? undefined : v
}

export async function checkLastValueAccess(
  user: User,
  collection: string,
  field: string
): Promise<LastValueRefusal | null> {
  if (!collection || !FIELD_RE.test(field))
    return { status: 400, error: 'collection and field are required' }
  if (isSystemCollection(collection) || /^(nivaro|directus)_/i.test(collection))
    return { status: 400, error: 'Not offered for system collections' }
  if (!(await can(user, 'read', collection))) return { status: 403, error: 'Forbidden' }
  const allowed = await getAllowedFields(user, 'read', collection)
  if (allowed && !allowed.includes('*') && !allowed.includes(field))
    return { status: 403, error: 'Forbidden' }
  if ((await getEncryptedFields(collection)).includes(field))
    return { status: 400, error: 'Not offered for encrypted fields' }
  return null
}

export async function myLastValue(
  userId: string,
  collection: string,
  field: string,
  excludeItem?: string | null
): Promise<LastValue | null> {
  let q = db('nivaro_activity')
    .where({ user: userId, collection })
    .whereIn('action', ['create', 'update'])
    .orderBy('timestamp', 'desc')
    .orderBy('id', 'desc')
    .limit(SCAN)
    .select('id', 'item', 'action', 'timestamp')
  if (excludeItem) q = q.whereNot('item', String(excludeItem))
  const acts = (await q) as Array<{
    id: number
    item: string | number | null
    action: string
    timestamp: Date | string | null
  }>
  if (!acts.length) return null
  const revs = (await db('nivaro_revisions')
    .whereIn(
      'activity',
      acts.map((a) => a.id)
    )
    .select('activity', 'data', 'delta')) as Array<{
    activity: number
    data: unknown
    delta: unknown
  }>
  const byActivity = new Map(revs.map((r) => [Number(r.activity), r]))
  for (const a of acts) {
    const rev = byActivity.get(Number(a.id))
    if (!rev) continue
    const v = valueSetBy(a.action, rev, field)
    if (v === undefined) continue
    const ts =
      a.timestamp instanceof Date ? a.timestamp : a.timestamp ? new Date(a.timestamp) : null
    return {
      value: v,
      item: String(a.item ?? ''),
      at: ts && !Number.isNaN(ts.getTime()) ? ts.toISOString() : null
    }
  }
  return null
}
