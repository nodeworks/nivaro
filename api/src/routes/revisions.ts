import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'
import { getRevision, listRevisions } from '../services/revisions.js'

export async function revisionsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/', async (req, reply) => {
    const q = req.query as { collection?: string; item?: string }
    if (!q.collection || !q.item) {
      return reply.code(400).send({ error: 'collection and item are required' })
    }
    const data = await listRevisions(q.collection, q.item)
    return reply.send({ data })
  })

  // GET /revisions/deleted-o2m?collection=X&many_field=Y&parent_id=Z
  // Returns revision snapshots of items deleted from an O2M child collection for a given parent.
  app.get('/deleted-o2m', async (req, reply) => {
    const { collection, many_field, parent_id } = req.query as { collection?: string; many_field?: string; parent_id?: string }
    if (!collection || !many_field || !parent_id) {
      return reply.code(400).send({ error: 'collection, many_field, and parent_id are required' })
    }
    // Validate many_field is a safe identifier to use inside JSON_VALUE path
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(many_field)) {
      return reply.code(400).send({ error: 'Invalid many_field' })
    }
    if (!(await can(req.user!, 'read', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    // Query delete revisions for this collection filtered by parent FK via MSSQL JSON_VALUE
    const rows = await db('nivaro_revisions as r')
      .join('nivaro_activity as a', 'r.activity', 'a.id')
      .leftJoin('nivaro_users as u', 'a.user', 'u.id')
      .where('a.collection', collection)
      .where('a.action', 'delete')
      .whereRaw(`JSON_VALUE(r.data, ?) = ?`, [`$.${many_field}`, String(parent_id)])
      .select(
        'a.item',
        'a.timestamp',
        'a.user as user_id',
        'u.first_name',
        'u.last_name',
        'u.email as user_email',
        'r.id as revision_id',
        'r.data'
      )
      .orderBy('a.timestamp', 'desc')
    const data = rows.map((row: Record<string, unknown>) => ({
      ...row,
      data: typeof row.data === 'string' ? (() => { try { return JSON.parse(row.data as string) } catch { return {} } })() : (row.data ?? {})
    }))
    return reply.send({ data })
  })

  // GET /revisions/o2m-snapshots?collection=X&many_field=Y&parent_id=Z
  // Returns all O2M revisions for a parent, ordered newest first, for client-side grouping.
  app.get('/o2m-snapshots', async (req, reply) => {
    const { collection, many_field, parent_id } = req.query as { collection?: string; many_field?: string; parent_id?: string }
    if (!collection || !many_field || !parent_id) {
      return reply.code(400).send({ error: 'collection, many_field, and parent_id are required' })
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(many_field)) {
      return reply.code(400).send({ error: 'Invalid many_field' })
    }
    if (!(await can(req.user!, 'read', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    const rows = await db('nivaro_revisions as r')
      .join('nivaro_activity as a', 'r.activity', 'a.id')
      .leftJoin('nivaro_users as u', 'a.user', 'u.id')
      .where('a.collection', collection)
      .whereIn('a.action', ['create', 'update', 'delete'])
      .whereRaw(`JSON_VALUE(r.data, ?) = ?`, [`$.${many_field}`, String(parent_id)])
      .select(
        'a.item as item_id',
        'a.action',
        'a.timestamp',
        'a.user as user_id',
        'u.first_name',
        'u.last_name',
        'u.email as user_email',
        'r.id as revision_id',
        'r.data'
      )
      .orderBy('a.timestamp', 'desc')
    const data = rows.map((row: Record<string, unknown>) => ({
      ...row,
      data: typeof row.data === 'string' ? (() => { try { return JSON.parse(row.data as string) } catch { return {} } })() : (row.data ?? {})
    }))
    return reply.send({ data })
  })

  // POST /revisions/o2m-restore — bulk-replace O2M rows with a snapshot.
  // Two modes: explicit rows[] OR target_timestamp (server reconstructs from revision history).
  app.post('/o2m-restore', async (req, reply) => {
    const { collection, many_field, parent_id, rows, target_timestamp } = req.body as {
      collection?: string
      many_field?: string
      parent_id?: string
      rows?: Array<Record<string, unknown>>
      target_timestamp?: string
    }
    if (!collection || !many_field || !parent_id) {
      return reply.code(400).send({ error: 'collection, many_field, and parent_id are required' })
    }
    if (!Array.isArray(rows) && !target_timestamp) {
      return reply.code(400).send({ error: 'Either rows or target_timestamp is required' })
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(many_field)) {
      return reply.code(400).send({ error: 'Invalid many_field' })
    }
    if (collection.startsWith('nivaro_')) {
      return reply.code(400).send({ error: 'Cannot restore system table rows' })
    }
    if (!(await can(req.user!, 'update', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    let restoredRows: Array<Record<string, unknown>>

    if (target_timestamp) {
      // Reconstruct: for each item that ever belonged to this parent, find its latest revision
      // at or before target_timestamp; include if not deleted.
      const allRevisions = await db('nivaro_revisions as r')
        .join('nivaro_activity as a', 'r.activity', 'a.id')
        .where('a.collection', collection)
        .whereRaw(`JSON_VALUE(r.data, ?) = ?`, [`$.${many_field}`, String(parent_id)])
        .where('a.timestamp', '<=', target_timestamp)
        .select('a.item as item_id', 'a.action', 'a.timestamp', 'r.data')
        .orderBy('a.timestamp', 'asc') as Array<{ item_id: string; action: string; timestamp: string; data: string | Record<string, unknown> }>

      // For each item_id, keep only the latest revision (last in ordered list)
      const latestByItem = new Map<string, { action: string; data: Record<string, unknown> }>()
      for (const rev of allRevisions) {
        const data = typeof rev.data === 'string' ? (() => { try { return JSON.parse(rev.data) } catch { return {} } })() : (rev.data ?? {})
        latestByItem.set(rev.item_id, { action: rev.action, data })
      }
      restoredRows = []
      for (const [, { action, data }] of latestByItem) {
        if (action !== 'delete') restoredRows.push(data)
      }
    } else {
      restoredRows = rows!
    }

    // Delete all current rows for this parent then insert restored snapshot
    await db(collection).where({ [many_field]: parent_id }).delete()
    for (const row of restoredRows) {
      const payload = { ...row }
      delete payload.id
      payload[many_field] = parent_id
      await db(collection).insert(payload)
    }
    await logActivity({
      action: 'o2m-restore',
      user: req.user?.id,
      collection,
      item: parent_id,
      comment: JSON.stringify({ many_field, restored_count: restoredRows.length }),
      req
    })
    return reply.send({ data: { success: true, restored: restoredRows.length } })
  })

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const revision = await getRevision(Number(id))
    if (!revision) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data: revision })
  })

  // POST /revisions/:id/rollback — restore item state from a revision snapshot
  app.post('/:id/rollback', async (req, reply) => {
    const { id } = req.params as { id: string }

    const revision = (await db('nivaro_revisions')
      .where({ id: Number(id) })
      .first()) as
      | { id: number; activity: number; data: string | Record<string, unknown> }
      | undefined
    if (!revision) return reply.code(404).send({ error: 'Not found' })

    // Parse the snapshot data
    let revisionData: Record<string, unknown>
    try {
      revisionData =
        typeof revision.data === 'string'
          ? (JSON.parse(revision.data) as Record<string, unknown>)
          : (revision.data as Record<string, unknown>)
    } catch {
      return reply.code(400).send({ error: 'Could not parse revision data' })
    }

    // Get the activity record to find collection + item
    const activity = (await db('nivaro_activity').where({ id: revision.activity }).first()) as
      | { id: number; collection: string | null; item: string | null }
      | undefined
    if (!activity || !activity.collection || !activity.item) {
      return reply.code(404).send({ error: 'Activity record not found for this revision' })
    }

    if (activity.collection.startsWith('nivaro_') && !(req.isAdmin ?? false)) {
      return reply.code(403).send({ error: 'Cannot rollback system table records' })
    }
    if (!(await can(req.user!, 'update', activity.collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    // Remove the id from the update payload
    const updatePayload = { ...revisionData }
    delete updatePayload.id

    // Restore the item
    await db(activity.collection).where({ id: activity.item }).update(updatePayload)

    // Log the rollback action
    await logActivity({
      action: 'rollback',
      user: req.user?.id,
      collection: activity.collection,
      item: activity.item,
      comment: JSON.stringify({ revision_id: id }),
      req
    })

    return reply.send({
      data: {
        success: true,
        collection: activity.collection,
        item: activity.item
      }
    })
  })
}
