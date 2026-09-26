import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { getCollection } from '../services/collections.js'
import { labelPathRecords } from '../services/event-path/record-labels.js'
import type { PathStep } from '../services/event-path/types.js'

/**
 * Per-user activity feed (admin only).
 *
 * GET /user-activity/:userId?page=&limit=50&action=create&collection=orders&sort=asc
 * GET /user-activity/:userId/summary
 */
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

    let query = db('nivaro_activity').where('user', userId)
    let countQuery = db('nivaro_activity').where('user', userId)

    if (q.action) {
      query = query.where('action', q.action)
      countQuery = countQuery.where('action', q.action)
    }
    if (q.collection) {
      query = query.where('collection', q.collection)
      countQuery = countQuery.where('collection', q.collection)
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
    return reply.send({ data: await withFriendlyLabels(data as ActivityRow[]), total, page, limit })
  })

  app.get('/:userId/summary', async (req, reply) => {
    const { userId } = req.params as { userId: string }

    const [actionRows, collectionRows, totalRows] = await Promise.all([
      db('nivaro_activity')
        .select('action')
        .count('id as count')
        .where('user', userId)
        .groupBy('action')
        .orderByRaw('count(id) desc'),
      db('nivaro_activity')
        .select('collection')
        .count('id as count')
        .where('user', userId)
        .whereNotNull('collection')
        .groupBy('collection')
        .orderByRaw('count(id) desc')
        .limit(10),
      db('nivaro_activity').where('user', userId).count('id as count')
    ])

    return reply.send({
      data: {
        total: Number((totalRows[0] as { count: string | number }).count),
        actions: (actionRows as Array<{ action: string; count: string | number }>).map((r) => ({
          action: r.action,
          count: Number(r.count)
        })),
        collections: await Promise.all(
          (collectionRows as Array<{ collection: string; count: string | number }>).map(
            async (r) => ({
              collection: r.collection,
              collection_label: await collectionLabel(r.collection),
              count: Number(r.count)
            })
          )
        )
      }
    })
  })
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
