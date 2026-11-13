import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { getCollection } from '../services/collections.js'
import { labelPathRecords } from '../services/event-path/record-labels.js'
import type { PathStep } from '../services/event-path/types.js'
import { junctionsOf, loadJunctionMap } from '../services/junction-map.js'
import { accessChangeIds, describeAccessChanges } from '../services/person-access-changes.js'

/**
 * Per-user activity feed (admin only).
 *
 * GET /user-activity/:userId?page=&limit=50&action=create&collection=orders&sort=asc&access=0
 * GET /user-activity/:userId/summary?access=0
 *
 * Besides the rows the person wrote, both include access changes made TO them by someone
 * else (grants, declines, User Scopes, role / status) — services/person-access-changes.ts;
 * `access=0` leaves them out. Those rows carry `about_them: true`, a readable `summary`
 * ("Access granted to Workflow CM26-365984 by Rob Lee"), a `detail` and `by`.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function extraIds(userId: string, q: Record<string, string>): Promise<number[]> {
  if (q.access === '0' || !UUID_RE.test(userId)) return []
  return accessChangeIds(userId).catch(() => [])
}

/** `user = id`, or one of the access changes made to them. */
function byOrAbout(userId: string, extra: number[]) {
  return (w: import('knex').Knex.QueryBuilder) => {
    w.where('user', userId)
    if (extra.length) w.orWhereIn('id', extra)
  }
}
export async function userActivityRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', requireAdmin)

  app.get('/:userId', async (req, reply) => {
    const { userId } = req.params as { userId: string }
    const q = req.query as Record<string, string>
    const limit = Math.min(q.limit ? Number(q.limit) : 50, 200)
    const page = Math.max(q.page ? Number(q.page) : 1, 1)
    const offset = (page - 1) * limit
    const sortDir = q.sort === 'asc' ? 'asc' : 'desc'
    const extra = await extraIds(userId, q)

    let query = db('nivaro_activity').where(byOrAbout(userId, extra))
    let countQuery = db('nivaro_activity').where(byOrAbout(userId, extra))

    if (q.action) {
      query = query.where('action', q.action)
      countQuery = countQuery.where('action', q.action)
    }
    if (q.collection) {
      // A collection's rows include its link tables' (they read as changes to it).
      const cols = [q.collection, ...junctionsOf(q.collection, await loadJunctionMap())]
      query = query.whereIn('collection', cols)
      countQuery = countQuery.whereIn('collection', cols)
    }
    if (q.date_from) {
      query = query.where('timestamp', '>=', q.date_from)
      countQuery = countQuery.where('timestamp', '>=', q.date_from)
    }
    if (q.date_to) {
      query = query.where('timestamp', '<=', q.date_to)
      countQuery = countQuery.where('timestamp', '<=', q.date_to)
    }

    const [data, countRows] = await Promise.all([
      query
        .select('id', 'action', 'user', 'timestamp', 'ip', 'collection', 'item', 'comment')
        .orderBy('timestamp', sortDir)
        .limit(limit)
        .offset(offset),
      countQuery.count('id as count')
    ])

    const total = Number((countRows[0] as { count: string | number }).count)
    const labelled = await withFriendlyLabels(data as ActivityRow[])
    const about = extra.length
      ? await describeAccessChanges(userId, labelled as never, new Set(extra)).catch(
          () => new Map()
        )
      : new Map()
    const rows = labelled.map((r) => {
      const line = about.get(Number(r.id))
      return line ? { ...r, about_them: true, ...line } : r
    })
    return reply.send({ data: rows, total, page, limit })
  })

  app.get('/:userId/summary', async (req, reply) => {
    const { userId } = req.params as { userId: string }
    const extra = await extraIds(userId, req.query as Record<string, string>)
    const mine = byOrAbout(userId, extra)

    const [actionRows, collectionRows, totalRows] = await Promise.all([
      db('nivaro_activity')
        .select('action')
        .count('id as count')
        .where(mine)
        .groupBy('action')
        .orderByRaw('count(id) desc'),
      db('nivaro_activity')
        .select('collection')
        .count('id as count')
        .where(mine)
        .whereNotNull('collection')
        .groupBy('collection')
        .orderByRaw('count(id) desc')
        .limit(30),
      db('nivaro_activity').where(mine).count('id as count')
    ])

    return reply.send({
      data: {
        total: Number((totalRows[0] as { count: string | number }).count),
        actions: (actionRows as Array<{ action: string; count: string | number }>).map((r) => ({
          action: r.action,
          count: Number(r.count)
        })),
        collections: await Promise.all(
          foldLinkTables(
            collectionRows as Array<{ collection: string; count: string | number }>,
            await loadJunctionMap()
          ).map(async (r) => ({
            collection: r.collection,
            collection_label: await collectionLabel(r.collection),
            count: r.count
          }))
        )
      }
    })
  })
}

/** Link-table counts folded into their parent collection; busiest ten. */
function foldLinkTables(
  rows: Array<{ collection: string; count: string | number }>,
  junctions: Map<string, { parent: string }>
): Array<{ collection: string; count: number }> {
  const by = new Map<string, number>()
  for (const r of rows) {
    const c = junctions.get(r.collection)?.parent ?? r.collection
    by.set(c, (by.get(c) ?? 0) + Number(r.count))
  }
  return [...by]
    .map(([collection, count]) => ({ collection, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
}

interface ActivityRow {
  id: number
  action: string
  collection: string | null
  item: string | null
  [k: string]: unknown
}

/** The registry's display name for a collection, else the table name as words. */
async function collectionLabel(collection: string): Promise<string> {
  try {
    const c = (await getCollection(collection)) as { display_name?: string | null } | null
    if (c?.display_name) return c.display_name
  } catch {
    // unregistered — fall through to the word form
  }
  return collection
    .split('_')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Attach the friendly record label (display template, or "Zone: Zone 3 · on
 * CR26-80332" for a junction row) and the collection's display name, the
 * same labelling the event path uses, so the feed never shows `workflows_regions #582230`.
 */
async function withFriendlyLabels(rows: ActivityRow[]): Promise<ActivityRow[]> {
  const steps: PathStep[] = rows.map(
    (r) =>
      ({
        record: r.collection && r.item ? { collection: r.collection, item: String(r.item) } : null
      }) as unknown as PathStep
  )
  try {
    await labelPathRecords(steps)
  } catch {
    // labels are decoration — the feed still renders ids
  }
  const collections = [...new Set(rows.map((r) => r.collection).filter((c): c is string => !!c))]
  const names = new Map<string, string>()
  await Promise.all(collections.map(async (c) => names.set(c, await collectionLabel(c))))
  return rows.map((r, i) => ({
    ...r,
    record_label: steps[i].record?.label ?? null,
    link: steps[i].record?.link ?? false,
    collection_label: r.collection ? (names.get(r.collection) ?? r.collection) : null
  }))
}
