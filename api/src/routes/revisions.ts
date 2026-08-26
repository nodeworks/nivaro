import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { chunkArray } from '../services/db-batch.js'
import { updateOne } from '../services/items.js'
import { can } from '../services/permissions.js'
import { getRevision, listRevisions } from '../services/revisions.js'

// Candidate child item ids for a parent's O2M history: rows currently linked
// plus items whose delete revision carried the parent FK. Filtering revisions
// by these ids hits the (collection, item) activity index — JSON_VALUE over
// every revision of a churn-heavy collection (1M+ rows post legacy import)
// times out even with the activity indexes in place.
async function o2mCandidateItemIds(
  collection: string,
  many_field: string,
  parent_id: string
): Promise<string[]> {
  const currentIds = (await db(collection)
    .where({ [many_field]: parent_id })
    .pluck('id')) as Array<string | number>
  const deletedRows = (await db('nivaro_revisions as r')
    .join('nivaro_activity as a', 'r.activity', 'a.id')
    .where('a.collection', collection)
    .where('a.action', 'delete')
    .whereRaw(`JSON_VALUE(r.data, ?) = ?`, [`$.${many_field}`, String(parent_id)])
    .select('a.item')) as Array<{ item: string | number }>
  return [...new Set([...currentIds.map(String), ...deletedRows.map((r) => String(r.item))])]
}

export async function revisionsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/', async (req, reply) => {
    const q = req.query as { collection?: string; item?: string; latest_only?: string }
    if (!q.collection || !q.item) {
      return reply.code(400).send({ error: 'collection and item are required' })
    }
    if (q.latest_only === '1') {
      // Collision-detection baseline: just the newest revision id, one cheap
      // MAX instead of hydrating the whole history.
      const row = (await db('nivaro_revisions')
        .where({ collection: q.collection, item: String(q.item) })
        .max({ latest: 'id' })
        .first()) as { latest?: number } | undefined
      return reply.send({ data: { latest: row?.latest ?? null } })
    }
    const data = await listRevisions(q.collection, q.item)
    return reply.send({ data })
  })

  // GET /revisions/deleted-o2m?collection=X&many_field=Y&parent_id=Z
  // Returns revision snapshots of items deleted from an O2M child collection for a given parent.
  /**
   * Revision value search (#98): "when did this value first appear" /
   * "which records ever held it". Per-record scope needs read permission and
   * scans one record's revisions; collection-wide is ADMIN-only (revisions
   * carry fields a role may not read) and is bounded by a date window +
   * TOP-N so the 6.5M-row table can't be scanned end to end. LIKE runs over
   * the DELTA (changed fields only, small) — field attribution is exact,
   * done in JS over the parsed JSON.
   */
  app.get('/value-search', async (req, reply) => {
    const q = req.query as {
      collection?: string
      q?: string
      item?: string
      field?: string
      days?: string
    }
    const collection = String(q.collection ?? '')
    const needle = String(q.q ?? '').trim()
    if (!collection || /^nivaro_/i.test(collection)) {
      return reply.code(400).send({ error: 'collection is required (business collections only)' })
    }
    if (needle.length < 2) {
      return reply.code(400).send({ error: 'Search value must be at least 2 characters' })
    }
    if (q.item) {
      if (!(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
    } else if (!req.isAdmin) {
      return reply
        .code(403)
        .send({ error: 'Collection-wide history search is admin-only — add an item id' })
    }

    const like = `%${needle.replace(/[%_[]/g, (c) => `[${c}]`)}%`
    const days = Math.min(730, Math.max(1, Number(q.days) || 90))
    let query = db('nivaro_revisions as r')
      .leftJoin('nivaro_activity as a', 'a.id', 'r.activity')
      .leftJoin('nivaro_users as u', 'u.id', 'a.user')
      .where('r.collection', collection)
      .orderBy('r.id', 'desc')
      .limit(200)
      .select(
        'r.id',
        'r.item',
        'r.delta',
        'a.action',
        'a.timestamp',
        db.raw("CONCAT(u.first_name, ' ', u.last_name) as user_name")
      )
    if (q.item) {
      query = query.where('r.item', String(q.item))
    } else {
      query = query.where('a.timestamp', '>=', new Date(Date.now() - days * 86_400_000))
    }
    query = query.where('r.delta', 'like', like)
    const rows = (await query) as Array<{
      id: number
      item: string
      delta: string | null
      action: string | null
      timestamp: Date | string | null
      user_name: string | null
    }>

    const matches = rows
      .map((r) => {
        let delta: Record<string, unknown> = {}
        try {
          delta = JSON.parse(r.delta ?? '{}') as Record<string, unknown>
        } catch {
          return null
        }
        const hits = Object.entries(delta)
          .filter(([k, v]) => {
            if (q.field && k !== q.field) return false
            const str = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
            return str.toLowerCase().includes(needle.toLowerCase())
          })
          .map(([k, v]) => ({
            field: k,
            value: (typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')).slice(0, 200)
          }))
        if (hits.length === 0) return null
        return {
          revision_id: r.id,
          item: r.item,
          action: r.action,
          timestamp: r.timestamp,
          user_name: r.user_name?.trim() || null,
          fields: hits
        }
      })
      .filter(Boolean)

    await logActivity({
      action: 'revision-value-search',
      user: req.user?.id,
      collection,
      comment: `"${needle.slice(0, 100)}"${q.item ? ` on ${q.item}` : ' (collection-wide)'}`,
      req
    })
    return reply.send({
      data: { matches, scanned: rows.length, truncated: rows.length >= 200 }
    })
  })

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
    const itemIds = await o2mCandidateItemIds(collection, many_field, String(parent_id))
    if (!itemIds.length) return reply.send({ data: [] })
    const rows: Record<string, unknown>[] = []
    for (const chunk of chunkArray(itemIds, 1000)) {
      const part = await db('nivaro_revisions as r')
        .join('nivaro_activity as a', 'r.activity', 'a.id')
        .leftJoin('nivaro_users as u', 'a.user', 'u.id')
        .where('a.collection', collection)
        .whereIn('a.action', ['create', 'update', 'delete'])
        .whereIn('a.item', chunk)
        // Items can move between parents; keep only revisions taken while the
        // row carried THIS parent's FK. Cheap now — the id filter has already
        // narrowed the candidate set.
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
      rows.push(...(part as Record<string, unknown>[]))
    }
    rows.sort((x, y) => String(y.timestamp).localeCompare(String(x.timestamp)))
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
      const itemIds = await o2mCandidateItemIds(collection, many_field, String(parent_id))
      const allRevisions: Array<{ item_id: string; action: string; timestamp: string; data: string | Record<string, unknown> }> = []
      for (const chunk of chunkArray(itemIds, 1000)) {
        const part = await db('nivaro_revisions as r')
          .join('nivaro_activity as a', 'r.activity', 'a.id')
          .where('a.collection', collection)
          .whereIn('a.item', chunk)
          .whereRaw(`JSON_VALUE(r.data, ?) = ?`, [`$.${many_field}`, String(parent_id)])
          .where('a.timestamp', '<=', target_timestamp)
          .select('a.item as item_id', 'a.action', 'a.timestamp', 'r.data') as Array<{ item_id: string; action: string; timestamp: string; data: string | Record<string, unknown> }>
        allRevisions.push(...part)
      }
      allRevisions.sort((x, y) => String(x.timestamp).localeCompare(String(y.timestamp)))

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

  // POST /revisions/:id/revert-field — single-field revert (#667). Takes JUST
  // one field's value from a revision snapshot and writes it through the items
  // service AS THE CALLER, so RBAC/RLS/validation/hooks/activity all apply —
  // unlike the whole-snapshot rollback above, which raw-writes deliberately.
  app.post('/:id/revert-field', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { field } = (req.body ?? {}) as { field?: string }
    if (!field || typeof field !== 'string') {
      return reply.code(400).send({ error: 'field is required' })
    }
    if (field === 'id') {
      return reply.code(400).send({ error: 'Cannot revert the id field' })
    }

    const revision = (await db('nivaro_revisions')
      .where({ id: Number(id) })
      .first()) as
      | { id: number; activity: number; data: string | Record<string, unknown> }
      | undefined
    if (!revision) return reply.code(404).send({ error: 'Not found' })

    let revisionData: Record<string, unknown>
    try {
      revisionData =
        typeof revision.data === 'string'
          ? (JSON.parse(revision.data) as Record<string, unknown>)
          : (revision.data as Record<string, unknown>)
    } catch {
      return reply.code(400).send({ error: 'Could not parse revision data' })
    }

    const activity = (await db('nivaro_activity').where({ id: revision.activity }).first()) as
      | { id: number; collection: string | null; item: string | null }
      | undefined
    if (!activity || !activity.collection || !activity.item) {
      return reply.code(404).send({ error: 'Activity record not found for this revision' })
    }
    if (activity.collection.startsWith('nivaro_')) {
      return reply.code(400).send({ error: 'Cannot revert system table fields' })
    }
    if (!(await can(req.user!, 'update', activity.collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    if (!(field in revisionData)) {
      return reply
        .code(400)
        .send({ error: `Field "${field}" is not present in this revision snapshot` })
    }

    // Through the items service — validation rules, field rules, computed
    // fields, RLS and the after-hooks (incl. a fresh revision) all apply.
    await updateOne(req.user!, activity.collection, activity.item, {
      [field]: revisionData[field]
    }, req)

    await logActivity({
      action: 'revision-field-revert',
      user: req.user?.id,
      collection: activity.collection,
      item: activity.item,
      comment: JSON.stringify({ revision_id: Number(id), field }),
      req
    })

    return reply.send({
      data: {
        success: true,
        collection: activity.collection,
        item: activity.item,
        field
      }
    })
  })
}
