import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'

interface FieldWatch {
  id: number
  name: string
  collection: string
  field: string
  is_active: boolean
  created_by: string | null
  created_at: Date
  updated_at: Date
}

interface FieldWatchSubscriber {
  id: number
  watch: number
  user: string
}

function formatWatch(
  row: FieldWatch & { subscriber_count?: number | string; is_subscribed?: number | boolean }
) {
  return {
    ...row,
    is_active: !!row.is_active,
    subscriber_count: Number(row.subscriber_count ?? 0),
    is_subscribed: !!row.is_subscribed
  }
}

export async function fieldWatchesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // GET / — list watches
  app.get('/', async (req, reply) => {
    const userId = req.user!.id

    if (req.isAdmin) {
      // Admins see all watches with subscriber count + is_subscribed for self
      const rows = await db('nivaro_field_watches as fw')
        .leftJoin(
          db('nivaro_field_watch_subscribers').count('id as cnt').groupBy('watch').as('sc'),
          'fw.id',
          'sc.watch'
        )
        .leftJoin(
          db('nivaro_field_watch_subscribers')
            .where('user', userId)
            .select('watch', db.raw('1 as subbed'))
            .as('my'),
          'fw.id',
          'my.watch'
        )
        .select(
          'fw.id',
          'fw.name',
          'fw.collection',
          'fw.field',
          'fw.is_active',
          'fw.created_by',
          'fw.created_at',
          'fw.updated_at',
          db.raw('ISNULL(sc.cnt, 0) as subscriber_count'),
          db.raw('ISNULL(my.subbed, 0) as is_subscribed')
        )
        .orderBy('fw.name')

      return reply.send({ data: rows.map(formatWatch) })
    }

    // Non-admin: only watches they're subscribed to
    const rows = await db('nivaro_field_watches as fw')
      .join('nivaro_field_watch_subscribers as sub', 'fw.id', 'sub.watch')
      .leftJoin(
        db('nivaro_field_watch_subscribers').count('id as cnt').groupBy('watch').as('sc'),
        'fw.id',
        'sc.watch'
      )
      .where('sub.user', userId)
      .where('fw.is_active', true)
      .select(
        'fw.id',
        'fw.name',
        'fw.collection',
        'fw.field',
        'fw.is_active',
        'fw.created_by',
        'fw.created_at',
        'fw.updated_at',
        db.raw('ISNULL(sc.cnt, 0) as subscriber_count'),
        db.raw('1 as is_subscribed')
      )
      .orderBy('fw.name')

    return reply.send({ data: rows.map(formatWatch) })
  })

  // GET /:id — get one watch
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const { id } = req.params
    const userId = req.user!.id

    const watch = (await db<FieldWatch>('nivaro_field_watches')
      .where({ id: Number(id) })
      .first()) as FieldWatch | undefined
    if (!watch) return reply.code(404).send({ error: 'Not found' })

    // Non-admin: can only see watches they're subscribed to
    if (!req.isAdmin) {
      const sub = await db<FieldWatchSubscriber>('nivaro_field_watch_subscribers')
        .where({ watch: watch.id, user: userId })
        .first()
      if (!sub) return reply.code(403).send({ error: 'Forbidden' })

      return reply.send({
        data: {
          ...watch,
          is_active: !!watch.is_active,
          is_subscribed: true,
          subscribers: []
        }
      })
    }

    // Admin: return full subscriber list
    const subscribers = await db('nivaro_field_watch_subscribers as s')
      .join('nivaro_users as u', 's.user', 'u.id')
      .where({ 's.watch': watch.id })
      .select('u.id', 'u.first_name', 'u.last_name', 'u.email', 's.id as subscription_id')

    const isSubscribed = subscribers.some((s: { id: string }) => s.id === userId)

    return reply.send({
      data: {
        ...watch,
        is_active: !!watch.is_active,
        is_subscribed: isSubscribed,
        subscribers
      }
    })
  })

  // POST / — create watch (admin only)
  /** Feature flag for the self-serve record-watch button — OFF by default. */
  app.get('/config', async () => {
    const row = (await db('nivaro_settings').where({ id: 1 }).first('field_watch_enabled')) as
      | { field_watch_enabled: boolean | number | null }
      | undefined
    return { data: { enabled: !!row?.field_watch_enabled } }
  })

  /**
   * Record-level field watch (#58): "tell me when THIS record's THIS field
   * changes". Self-serve — finds or creates the (collection, field, item)
   * watch and subscribes the caller. Gated on the instance feature flag AND
   * read permission for the collection.
   */
  app.post<{ Body: { collection?: string; field?: string; item_id?: string } }>(
    '/self',
    async (req, reply) => {
      const { collection, field, item_id } = req.body ?? {}
      if (!collection || !field || !item_id) {
        return reply.code(400).send({ error: 'collection, field and item_id are required' })
      }
      const flag = (await db('nivaro_settings').where({ id: 1 }).first('field_watch_enabled')) as
        | { field_watch_enabled: boolean | number | null }
        | undefined
      if (!flag?.field_watch_enabled) {
        return reply.code(403).send({ error: 'Field watches are not enabled on this instance' })
      }
      if (!req.isAdmin && !(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      let watch = (await db('nivaro_field_watches')
        .where({ collection, field, item_id: String(item_id) })
        .first()) as { id: number } | undefined
      if (!watch) {
        const now = new Date()
        const [row] = (await db('nivaro_field_watches')
          .insert({
            name: `${collection}.${field} on #${item_id}`.slice(0, 255),
            collection,
            field,
            item_id: String(item_id),
            is_active: true,
            created_by: req.user!.id,
            created_at: now,
            updated_at: now
          })
          .returning('id')) as Array<{ id: number } | number>
        watch = { id: typeof row === 'object' ? row.id : row }
      }
      const existing = await db('nivaro_field_watch_subscribers')
        .where({ watch: watch.id, user: req.user!.id })
        .first('id')
      if (!existing) {
        await db('nivaro_field_watch_subscribers').insert({ watch: watch.id, user: req.user!.id })
      }
      await logActivity({
        action: 'field-watch-subscribe',
        user: req.user?.id,
        collection,
        item: String(item_id),
        comment: field,
        req
      })
      return { data: { watch_id: watch.id, watching: true } }
    }
  )

  /** Unwatch: drop the caller's subscription; a record-scoped watch with no
   *  subscribers left is deleted rather than lingering as config debris. */
  app.delete<{ Querystring: { collection?: string; field?: string; item_id?: string } }>(
    '/self',
    async (req, reply) => {
      const { collection, field, item_id } = req.query ?? {}
      if (!collection || !field || !item_id) {
        return reply.code(400).send({ error: 'collection, field and item_id are required' })
      }
      const watch = (await db('nivaro_field_watches')
        .where({ collection, field, item_id: String(item_id) })
        .first('id')) as { id: number } | undefined
      if (!watch) return { data: { watching: false } }
      await db('nivaro_field_watch_subscribers')
        .where({ watch: watch.id, user: req.user!.id })
        .del()
      const remaining = await db('nivaro_field_watch_subscribers')
        .where({ watch: watch.id })
        .first('id')
      if (!remaining) await db('nivaro_field_watches').where({ id: watch.id }).del()
      return { data: { watching: false } }
    }
  )

  /** Is the caller watching this record's field? Batched per record. */
  app.get<{ Querystring: { collection?: string; item_id?: string } }>(
    '/self',
    async (req, reply) => {
      const { collection, item_id } = req.query
      if (!collection || !item_id) {
        return reply.code(400).send({ error: 'collection and item_id are required' })
      }
      const rows = (await db('nivaro_field_watches as w')
        .join('nivaro_field_watch_subscribers as s', 's.watch', 'w.id')
        .where({ 'w.collection': collection, 'w.item_id': String(item_id), 's.user': req.user!.id })
        .select('w.field')) as Array<{ field: string }>
      return { data: rows.map((r) => r.field) }
    }
  )

  app.post<{ Body: { name: string; collection: string; field: string; is_active?: boolean } }>(
    '/',
    async (req, reply) => {
      if (!req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })

      const { name, collection, field, is_active = true } = req.body ?? {}
      const itemId = (req.body as { item_id?: string | null })?.item_id ?? null
      if (!name || !collection || !field) {
        return reply.code(400).send({ error: 'name, collection, and field are required' })
      }

      const now = new Date()
      const [row] = (await db('nivaro_field_watches')
        .insert({
          name,
          collection,
          field,
          item_id: itemId,
          is_active,
          created_by: req.user!.id,
          created_at: now,
          updated_at: now
        })
        .returning('*')) as unknown as [FieldWatch]

      await logActivity({
        action: 'create',
        user: req.user?.id,
        collection: 'nivaro_field_watches',
        item: String(row.id),
        req
      })

      return reply.code(201).send({ data: { ...row, is_active: !!row.is_active } })
    }
  )

  // PATCH /:id — update watch (admin only)
  app.patch<{
    Params: { id: string }
    Body: { name?: string; collection?: string; field?: string; is_active?: boolean }
  }>('/:id', async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })

    const { id } = req.params
    const existing = await db<FieldWatch>('nivaro_field_watches')
      .where({ id: Number(id) })
      .first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const allowed = ['name', 'collection', 'field', 'is_active']
    const body = req.body as Record<string, unknown>
    const patch = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)))

    await db('nivaro_field_watches')
      .where({ id: Number(id) })
      .update({ ...patch, updated_at: new Date() })

    const updated = (await db<FieldWatch>('nivaro_field_watches')
      .where({ id: Number(id) })
      .first()) as FieldWatch

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_field_watches',
      item: id,
      req
    })

    return reply.send({ data: { ...updated, is_active: !!updated.is_active } })
  })

  // DELETE /:id — delete watch + subscribers (admin only)
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })

    const { id } = req.params
    const existing = await db<FieldWatch>('nivaro_field_watches')
      .where({ id: Number(id) })
      .first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    await db('nivaro_field_watch_subscribers')
      .where({ watch: Number(id) })
      .delete()
    await db('nivaro_field_watches')
      .where({ id: Number(id) })
      .delete()

    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_field_watches',
      item: id,
      req
    })

    return reply.code(204).send()
  })

  // POST /:id/subscribe — subscribe current user (upsert)
  app.post<{ Params: { id: string } }>('/:id/subscribe', async (req, reply) => {
    const { id } = req.params
    const userId = req.user!.id

    const watch = await db<FieldWatch>('nivaro_field_watches')
      .where({ id: Number(id) })
      .first()
    if (!watch) return reply.code(404).send({ error: 'Not found' })

    // Gate: user must have read access to the watched collection
    if (!req.isAdmin && !(await can(req.user!, 'read', watch.collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const existing = await db<FieldWatchSubscriber>('nivaro_field_watch_subscribers')
      .where({ watch: Number(id), user: userId })
      .first()

    if (!existing) {
      await db('nivaro_field_watch_subscribers').insert({
        watch: Number(id),
        user: userId
      })
      await logActivity({
        action: 'subscribe',
        user: userId,
        collection: 'nivaro_field_watches',
        item: id,
        comment: watch.name,
        req
      })
    }

    return reply.code(201).send({ data: { watch: Number(id), user: userId } })
  })

  // DELETE /:id/subscribe — unsubscribe current user
  app.delete<{ Params: { id: string } }>('/:id/subscribe', async (req, reply) => {
    const { id } = req.params
    const userId = req.user!.id

    const removed = await db('nivaro_field_watch_subscribers')
      .where({ watch: Number(id), user: userId })
      .delete()

    if (removed > 0) {
      await logActivity({
        action: 'unsubscribe',
        user: userId,
        collection: 'nivaro_field_watches',
        item: id,
        req
      })
    }

    return reply.code(204).send()
  })
}
