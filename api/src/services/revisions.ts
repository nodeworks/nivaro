import { db } from '../db/index.js'

export interface Revision {
  id: number
  activity: number | null
  collection: string
  item: string
  data: Record<string, unknown>
  delta: Record<string, unknown> | null
  parent: number | null
  // Joined from nivaro_activity + nivaro_users
  timestamp?: Date
  action?: string
  user_id?: string | null
  first_name?: string | null
  last_name?: string | null
  user_email?: string | null
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  try {
    return typeof value === 'string' ? JSON.parse(value) : (value as Record<string, unknown>)
  } catch {
    return null
  }
}

export function computeDelta(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Record<string, unknown> {
  const delta: Record<string, unknown> = {}
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      delta[key] = after[key]
    }
  }
  return delta
}

export async function writeRevision(opts: {
  activity: number | null
  collection: string
  item: string
  data: Record<string, unknown>
  delta: Record<string, unknown> | null
}): Promise<void> {
  try {
    await db('nivaro_revisions').insert({
      activity: opts.activity,
      collection: opts.collection,
      item: opts.item,
      data: JSON.stringify(opts.data),
      delta: opts.delta ? JSON.stringify(opts.delta) : null
    })
  } catch (err) {
    console.error({ err }, 'Failed to write revision')
  }
}

function hydrateRevision(row: Record<string, unknown>): Revision {
  return {
    ...(row as unknown as Revision),
    data: parseJson(row.data) ?? {},
    delta: parseJson(row.delta)
  }
}

export async function listRevisions(collection: string, item: string): Promise<Revision[]> {
  const rows = (await db('nivaro_revisions as r')
    .leftJoin('nivaro_activity as a', 'r.activity', 'a.id')
    .leftJoin('nivaro_users as u', 'a.user', 'u.id')
    .select(
      'r.id',
      'r.activity',
      'r.collection',
      'r.item',
      'r.data',
      'r.delta',
      'r.parent',
      'a.timestamp',
      'a.action',
      'a.user as user_id',
      'u.first_name',
      'u.last_name',
      'u.email as user_email'
    )
    .where('r.collection', collection)
    .where('r.item', item)
    .orderBy('r.id', 'desc')
    .limit(100)) as Record<string, unknown>[]

  return rows.map(hydrateRevision)
}

export async function getRevision(id: number): Promise<Revision | null> {
  const row = (await db('nivaro_revisions as r')
    .leftJoin('nivaro_activity as a', 'r.activity', 'a.id')
    .leftJoin('nivaro_users as u', 'a.user', 'u.id')
    .select(
      'r.id',
      'r.activity',
      'r.collection',
      'r.item',
      'r.data',
      'r.delta',
      'r.parent',
      'a.timestamp',
      'a.action',
      'a.user as user_id',
      'u.first_name',
      'u.last_name',
      'u.email as user_email'
    )
    .where('r.id', id)
    .first()) as Record<string, unknown> | undefined

  return row ? hydrateRevision(row) : null
}
