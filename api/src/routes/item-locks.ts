import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

const LOCK_TTL_MS = 5 * 60 * 1000 // 5 minutes

interface ItemLock {
  id: number
  collection: string
  item: string
  user: string
  locked_at: Date
  expires_at: Date
  note?: string | null
}

const NOTE_MAX = 300

function isExpired(lock: ItemLock): boolean {
  return new Date(lock.expires_at).getTime() <= Date.now()
}

function cleanNote(raw: unknown): string | null {
  if (raw == null) return null
  const s = String(raw).trim().slice(0, NOTE_MAX)
  return s.length > 0 ? s : null
}

// The Fastify instance, for the release paths that run outside a handler's
// closure (an expired lock discovered by getCurrentLock). Set in itemLocksRoutes.
let _app: FastifyInstance | null = null

async function getCurrentLock(collection: string, item: string): Promise<ItemLock | null> {
  const lock = (await db('nivaro_item_locks').where({ collection, item }).first()) as
    | ItemLock
    | undefined
  if (!lock) return null
  if (isExpired(lock)) {
    await db('nivaro_item_locks').where({ id: lock.id }).delete()
    // An expiry IS a release — the next person in line should hear about it.
    if (_app) await handOffToQueue(_app, collection, item)
    return null
  }
  return lock
}

// ── Wait queue (migration 306) ─────────────────────────────────────────────
// nivaro_item_lock_queue: who is waiting for a record, in the order they
// asked. When the lock is released the FIRST row is popped and told (socket
// `lock:available` to their user room + an in-app notification) so their
// client auto-acquires; everyone else stays queued for the next release.

interface QueueEntry {
  user: string
  name: string
  requested_at: Date
}

async function queueFor(collection: string, item: string): Promise<QueueEntry[]> {
  const rows = (await db('nivaro_item_lock_queue as q')
    .leftJoin('nivaro_users as u', 'u.id', 'q.user')
    .where({ 'q.collection': collection, 'q.item': item })
    .orderBy('q.requested_at', 'asc')
    .orderBy('q.id', 'asc')
    .select('q.user', 'q.requested_at', 'u.first_name', 'u.last_name', 'u.email')) as Array<{
    user: string
    requested_at: Date
    first_name: string | null
    last_name: string | null
    email: string | null
  }>
  return rows.map((r) => ({
    user: r.user,
    name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || r.user,
    requested_at: r.requested_at
  }))
}

function queuePosition(queue: QueueEntry[], userId: string): number | null {
  const idx = queue.findIndex((q) => String(q.user).toUpperCase() === String(userId).toUpperCase())
  return idx === -1 ? null : idx + 1
}

async function leaveQueue(collection: string, item: string, userId: string): Promise<void> {
  await db('nivaro_item_lock_queue')
    .where({ collection, item })
    .whereRaw('UPPER([user]) = ?', [String(userId).toUpperCase()])
    .delete()
    .catch(() => {})
}

/**
 * Pop the head of the wait queue and tell them the record is free. Called on
 * every release path (explicit release, idle release, expiry, handoff
 * response). Never throws — a release must never fail because the hand-off
 * notification did.
 */
async function handOffToQueue(app: FastifyInstance, collection: string, item: string) {
  try {
    const queue = await queueFor(collection, item)
    const next = queue[0]
    if (!next) return
    await db('nivaro_item_lock_queue')
      .where({ collection, item })
      .whereRaw('UPPER([user]) = ?', [String(next.user).toUpperCase()])
      .delete()
    app.io?.to(`user:${next.user}`).emit('lock:available', { collection, item: String(item) })
    const { notifyUser } = await import('../services/notification-channels.js')
    await notifyUser(app, next.user, {
      subject: `It's your turn to edit ${collection}/${item}`,
      message: `The edit lock on ${collection}/${item} was released and you were next in line.`,
      collection,
      item: String(item),
      category: 'system',
      target: { kind: 'record', collection, id: String(item) }
    }).catch(() => {})
  } catch {
    /* hand-off is best-effort */
  }
}

async function lockHolderName(userId: string): Promise<string | null> {
  const user = (await db('nivaro_users')
    .where({ id: userId })
    .select('first_name', 'last_name', 'email')
    .first()) as { first_name: string | null; last_name: string | null; email: string } | undefined
  if (!user) return null
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ')
  return name || user.email
}

/** Returns true when item_locking_enabled is 1/true for the collection. */
async function isLockingEnabled(collection: string): Promise<boolean> {
  try {
    const row = (await db('nivaro_collections')
      .where({ collection })
      .select('item_locking_enabled')
      .first()) as { item_locking_enabled: number | boolean } | undefined
    if (!row) return true
    return row.item_locking_enabled === 1 || row.item_locking_enabled === true
  } catch {
    return true // column missing (migration pending) — default enabled
  }
}

/**
 * Broadcast lock state to viewers of the item. Clients join via the existing
 * Socket.io collection-item room.
 */
function emitLockEvent(
  app: FastifyInstance,
  collection: string,
  item: string,
  user: string,
  locked: boolean
) {
  app.io?.to(`item:${collection}:${item}`).emit('item-lock', { collection, item, user, locked })
}

export async function itemLocksRoutes(app: FastifyInstance) {
  _app = app
  app.addHook('preHandler', authenticate)

  // ── Config: GET/PATCH locking enabled flag per collection (admin) ─────────

  app.get('/config/:collection', { preHandler: [requireAdmin] }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    try {
      const enabled = await isLockingEnabled(collection)
      return reply.send({ data: { collection, item_locking_enabled: enabled } })
    } catch {
      return reply.send({ data: { collection, item_locking_enabled: true } })
    }
  })

  app.patch('/config/:collection', { preHandler: [requireAdmin] }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const { item_locking_enabled } = req.body as { item_locking_enabled: boolean }

    const exists = await db('nivaro_collections').where({ collection }).first()
    if (!exists) return reply.code(404).send({ error: 'Collection not found' })

    await db('nivaro_collections')
      .where({ collection })
      .update({ item_locking_enabled: item_locking_enabled ? 1 : 0 })

    // Release all active locks when disabling
    if (!item_locking_enabled) {
      await db('nivaro_item_locks').where({ collection }).delete()
      app.io?.to(`collection:${collection}`).emit('item-lock-disabled', { collection })
    }

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_collections',
      item: collection,
      comment: `item_locking_enabled: ${item_locking_enabled}`,
      req
    })

    return reply.send({ data: { collection, item_locking_enabled } })
  })

  // ── Lock state ────────────────────────────────────────────────────────────

  // GET /:collection/:item/lock — current lock state (null when free/expired/disabled)
  app.get('/:collection/:item/lock', { preHandler: [requireAuth] }, async (req, reply) => {
    const { collection, item } = req.params as { collection: string; item: string }

    if (!(await isLockingEnabled(collection))) {
      return reply.send({ data: null, locking_disabled: true })
    }

    const lock = await getCurrentLock(collection, item)
    const queue = await queueFor(collection, item)
    const my_position = queuePosition(queue, req.user!.id)
    // Free record: `data` stays null (clients read null = free) but the queue
    // still rides along so a waiting client can show its position.
    if (!lock) return reply.send({ data: null, queue, my_position })

    return reply.send({
      data: {
        collection: lock.collection,
        item: lock.item,
        user: lock.user,
        locked_by: lock.user,
        locked_by_name: await lockHolderName(lock.user),
        note: lock.note ?? null,
        locked_at: lock.locked_at,
        expires_at: lock.expires_at,
        is_mine: lock.user === req.user!.id,
        queue,
        my_position
      }
    })
  })

  // POST /:collection/:item/lock — acquire/refresh lock for the current user
  // All live locks (#89) — the admin console behind force-unlock: who is
  // holding what, for how long. Expired rows are excluded, not deleted (the
  // holder's heartbeat may still refresh them).
  app.get('/', { preHandler: [requireAuth] }, async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Admin only' })
    const rows = (await db('nivaro_item_locks as l')
      .leftJoin('nivaro_users as u', 'u.id', 'l.user')
      .where('l.expires_at', '>', new Date())
      .orderBy('l.locked_at', 'desc')
      .limit(200)
      .select(
        'l.id',
        'l.collection',
        'l.item',
        'l.user',
        'l.locked_at',
        'l.expires_at',
        'l.note',
        db.raw("CONCAT(u.first_name, ' ', u.last_name) as holder_name"),
        'u.email as holder_email'
      )) as Array<Record<string, unknown>>
    return reply.send({ data: rows })
  })

  app.post<{ Params: { collection: string; item: string } }>(
    '/:collection/:item/lock',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { collection, item } = req.params
      const me = req.user!.id
      const body = (req.body ?? {}) as { note?: unknown }
      const noteGiven = body.note !== undefined
      const note = cleanNote(body.note)

      // Silently no-op when locking is disabled for this collection
      if (!(await isLockingEnabled(collection))) {
        return reply.send({ data: null, locking_disabled: true })
      }

      const existing = await getCurrentLock(collection, item)
      if (existing && existing.user !== me) {
        return reply.code(409).send({
          error: 'Item is locked by another user',
          locked_by: existing.user,
          locked_by_name: await lockHolderName(existing.user),
          note: existing.note ?? null,
          expires_at: existing.expires_at
        })
      }

      const now = new Date()
      const expiresAt = new Date(now.getTime() + LOCK_TTL_MS)

      if (existing) {
        await db('nivaro_item_locks')
          .where({ id: existing.id })
          .update(noteGiven ? { expires_at: expiresAt, note } : { expires_at: expiresAt })
      } else {
        try {
          await db('nivaro_item_locks').insert({
            collection,
            item,
            user: me,
            locked_at: now,
            expires_at: expiresAt,
            note
          })
        } catch {
          const winner = await getCurrentLock(collection, item)
          if (winner && winner.user !== me) {
            return reply.code(409).send({
              error: 'Item is locked by another user',
              locked_by: winner.user,
              locked_by_name: await lockHolderName(winner.user),
              note: winner.note ?? null,
              expires_at: winner.expires_at
            })
          }
        }
      }

      // Holding the lock means no longer waiting for it.
      await leaveQueue(collection, item, me)
      emitLockEvent(app, collection, item, me, true)

      if (!existing) {
        await logActivity({
          action: 'lock-acquire',
          user: me,
          collection,
          item: String(item),
          req
        })
      }

      const lock = await getCurrentLock(collection, item)
      return reply.send({
        data: lock
          ? {
              collection,
              item,
              user: lock.user,
              locked_by: lock.user,
              note: lock.note ?? null,
              locked_at: lock.locked_at,
              expires_at: lock.expires_at
            }
          : null
      })
    }
  )

  // POST /:collection/:item/lock/note — the holder updates their own note.
  app.post<{ Params: { collection: string; item: string }; Body: { note?: unknown } }>(
    '/:collection/:item/lock/note',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { collection, item } = req.params
      const me = req.user!.id
      const existing = await getCurrentLock(collection, item)
      if (!existing || existing.user !== me) {
        return reply.code(403).send({ error: 'You do not hold a lock on this item' })
      }
      const note = cleanNote(req.body?.note)
      await db('nivaro_item_locks').where({ id: existing.id }).update({ note })
      emitLockEvent(app, collection, item, me, true)
      return reply.send({ data: { collection, item, user: me, note } })
    }
  )

  // POST /:collection/:item/lock/queue — join the wait queue (idempotent).
  app.post<{ Params: { collection: string; item: string } }>(
    '/:collection/:item/lock/queue',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { collection, item } = req.params
      const me = req.user!
      if (!(await isLockingEnabled(collection))) {
        return reply.send({ data: null, locking_disabled: true })
      }
      const existing = await getCurrentLock(collection, item)
      if (existing && existing.user === me.id) {
        return reply.code(400).send({ error: 'You already hold this lock' })
      }
      let queue = await queueFor(collection, item)
      const already = queuePosition(queue, me.id)
      if (already === null) {
        try {
          await db('nivaro_item_lock_queue').insert({
            collection,
            item: String(item),
            user: me.id,
            requested_at: new Date()
          })
        } catch {
          /* UNIQUE race — already queued */
        }
        queue = await queueFor(collection, item)
      }
      const position = queuePosition(queue, me.id) ?? queue.length
      // Tell the holder someone is waiting — same channels as lock/request.
      if (existing && already === null) {
        const fromName =
          [me.first_name, me.last_name].filter(Boolean).join(' ') || me.email || me.id
        app.io?.to(`user:${existing.user}`).emit('lock:queued', {
          collection,
          item: String(item),
          user_name: fromName,
          position,
          from: { id: me.id, name: fromName }
        })
        const { notifyUser } = await import('../services/notification-channels.js')
        await notifyUser(app, existing.user, {
          subject: 'Someone is waiting to edit',
          message: `${fromName} is waiting for ${collection}/${item} (position ${position} in line).`,
          collection,
          item: String(item),
          sender: me.id,
          category: 'system',
          target: { kind: 'record', collection, id: String(item) }
        }).catch(() => {})
      }
      return reply.send({ data: { position, queue } })
    }
  )

  // DELETE /:collection/:item/lock/queue — leave the wait queue.
  app.delete<{ Params: { collection: string; item: string } }>(
    '/:collection/:item/lock/queue',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { collection, item } = req.params
      await leaveQueue(collection, item, req.user!.id)
      return reply.code(204).send()
    }
  )

  // POST /:collection/:item/heartbeat — extend own lock (no-op when disabled)
  // Takeover permission (#256): roles listed in settings.lock_takeover_roles
  // may FORCE-take a lock (delete + re-acquire) — the holder finds out on
  // their next heartbeat (the existing 404-with-holder path) and via an
  // in-app notification. Admins always may.
  app.post<{ Params: { collection: string; item: string } }>(
    '/:collection/:item/lock/force',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { collection, item } = req.params
      if (!(await isLockingEnabled(collection))) {
        return reply.send({ data: null, locking_disabled: true })
      }
      if (!req.isAdmin) {
        let allowed: string[] = []
        try {
          const settings = (await db('nivaro_settings').first('lock_takeover_roles')) as
            | { lock_takeover_roles?: string | null }
            | undefined
          allowed = settings?.lock_takeover_roles
            ? (JSON.parse(settings.lock_takeover_roles) as string[])
            : []
        } catch {
          allowed = []
        }
        const mine = String(req.user?.role ?? '').toUpperCase()
        if (!allowed.some((r) => String(r).toUpperCase() === mine)) {
          return reply.code(403).send({ error: 'Your role may not take over locks' })
        }
      }
      const existing = await getCurrentLock(collection, item)
      if (existing && existing.user !== req.user!.id) {
        await db('nivaro_item_locks').where({ collection, item }).del()
        const { notifyUser } = await import('../services/notification-channels.js')
        void notifyUser(app, existing.user, {
          subject: 'Your edit lock was taken over',
          message: `${[req.user?.first_name, req.user?.last_name].filter(Boolean).join(' ') || 'An authorized user'} took over editing ${collection}/${item}. Unsaved changes there may conflict.`,
          collection,
          item,
          sender: req.user?.id ?? null
        }).catch(() => {})
      }
      await db('nivaro_item_locks').insert({
        collection,
        item,
        user: req.user!.id,
        locked_at: new Date(),
        expires_at: new Date(Date.now() + 5 * 60_000)
      })
      // The taker now holds it — they are no longer waiting. The rest of the
      // queue stays: the lock was not released, it changed hands.
      await leaveQueue(collection, item, req.user!.id)
      await logActivity({
        action: 'lock-force-take',
        user: req.user!.id,
        collection,
        item,
        req
      })
      return reply.send({ data: { taken: true } })
    }
  )

  app.post<{ Params: { collection: string; item: string } }>(
    '/:collection/:item/heartbeat',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { collection, item } = req.params
      const me = req.user!.id

      if (!(await isLockingEnabled(collection))) {
        return reply.send({ data: null, locking_disabled: true })
      }

      const existing = await getCurrentLock(collection, item)
      if (!existing || existing.user !== me) {
        // Say WHO holds it now. A heartbeat is the only moment a client whose
        // lock was taken over finds out, and without the holder it cannot show
        // the banner naming them — it would just stop beating and carry on
        // letting the person edit.
        return reply.code(404).send({
          error: 'You do not hold a lock on this item',
          locked_by: existing?.user ?? null,
          locked_by_name: existing ? await lockHolderName(existing.user) : null,
          note: existing?.note ?? null
        })
      }

      // Idle release: the heartbeat carries how long the holder has been
      // without real input. When settings.lock_idle_release_minutes is set and
      // the holder has idled past it, the lock is released server-side — a tab
      // left open must not hold a record hostage. The client re-acquires on
      // the holder's next real input if the record is still free.
      const idleSeconds = Number((req.body as { idle_seconds?: unknown } | null)?.idle_seconds)
      if (Number.isFinite(idleSeconds) && idleSeconds > 0) {
        const settings = (await db('nivaro_settings').first('lock_idle_release_minutes')) as
          | { lock_idle_release_minutes?: number | null }
          | undefined
        const idleMinutes = Number(settings?.lock_idle_release_minutes)
        if (Number.isFinite(idleMinutes) && idleMinutes > 0 && idleSeconds >= idleMinutes * 60) {
          await db('nivaro_item_locks').where({ id: existing.id }).del()
          emitLockEvent(app, collection, item, me, false)
          await handOffToQueue(app, collection, item)
          return reply.send({ data: null, idle_released: true })
        }
      }

      const expiresAt = new Date(Date.now() + LOCK_TTL_MS)
      await db('nivaro_item_locks').where({ id: existing.id }).update({ expires_at: expiresAt })

      return reply.send({ data: { collection, item, user: me, expires_at: expiresAt } })
    }
  )

  // DELETE /:collection/:item/lock — release own lock (admin: ?force=1 releases any)
  app.delete<{ Params: { collection: string; item: string }; Querystring: { force?: string } }>(
    '/:collection/:item/lock',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { collection, item } = req.params
      const me = req.user!.id
      const force = req.query.force === '1' && req.isAdmin

      const existing = await getCurrentLock(collection, item)
      if (!existing) return reply.code(204).send()

      if (existing.user !== me && !force) {
        return reply.code(403).send({ error: 'Lock is held by another user' })
      }

      await db('nivaro_item_locks').where({ id: existing.id }).delete()
      emitLockEvent(app, collection, item, existing.user, false)
      await handOffToQueue(app, collection, item)

      await logActivity({
        action: 'lock-release',
        user: me,
        collection,
        item: String(item),
        req
      })

      return reply.code(204).send()
    }
  )

  // ── Lock handoff (#286) ───────────────────────────────────────────────────
  // "Request the lock" pings the holder live (socket to their user room +
  // an in-app notification fallback); the holder releases or declines with a
  // note. Chat-them-and-wait, replaced with a button.
  app.post<{ Params: { collection: string; item: string } }>(
    '/:collection/:item/lock/request',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { collection, item } = req.params
      const me = req.user!
      const existing = await getCurrentLock(collection, item)
      if (!existing) return reply.code(404).send({ error: 'Nobody holds this lock' })
      if (existing.user === me.id)
        return reply.code(400).send({ error: 'You already hold this lock' })
      const fromName = [me.first_name, me.last_name].filter(Boolean).join(' ') || me.email || me.id
      app.io?.to(`user:${existing.user}`).emit('lock:requested', {
        collection,
        item: String(item),
        from: { id: me.id, name: fromName }
      })
      const { notifyUser } = await import('../services/notification-channels.js')
      await notifyUser(app, existing.user, {
        subject: 'Edit lock requested',
        message: `${fromName} is asking you to release ${collection}/${item} so they can edit it.`,
        collection,
        item: String(item),
        sender: me.id
      }).catch(() => {})
      return { data: { requested: true } }
    }
  )

  app.post<{
    Params: { collection: string; item: string }
    Body: { to?: string; action?: string; note?: string }
  }>('/:collection/:item/lock/respond', { preHandler: [requireAuth] }, async (req, reply) => {
    const { collection, item } = req.params
    const me = req.user!
    const to = String(req.body?.to ?? '')
    const action = req.body?.action === 'release' ? 'release' : 'decline'
    const note = String(req.body?.note ?? '').slice(0, 300)
    if (!to) return reply.code(400).send({ error: 'to (requester id) is required' })
    const existing = await getCurrentLock(collection, item)
    if (existing && existing.user === me.id && action === 'release') {
      await db('nivaro_item_locks').where({ id: existing.id }).delete()
      emitLockEvent(app, collection, item, me.id, false)
      // The explicit requester is the intended recipient (they get
      // lock:response below and auto-acquire); drop their queue row so the
      // hand-off does not ALSO wake the queue head and race them. When the
      // requester never queued, the head of the queue is told as usual.
      await leaveQueue(collection, item, to)
      await handOffToQueue(app, collection, item)
      await logActivity({
        action: 'lock-release',
        user: me.id,
        collection,
        item: String(item),
        req,
        comment: `handoff to ${to}`
      })
    }
    const myName = [me.first_name, me.last_name].filter(Boolean).join(' ') || me.email || me.id
    app.io?.to(`user:${to}`).emit('lock:response', {
      collection,
      item: String(item),
      action,
      note,
      from: { id: me.id, name: myName }
    })
    const { notifyUser } = await import('../services/notification-channels.js')
    await notifyUser(app, to, {
      subject: action === 'release' ? 'Lock released for you' : 'Lock request declined',
      message:
        action === 'release'
          ? `${myName} released ${collection}/${item} — it's yours.`
          : `${myName} declined to release ${collection}/${item}${note ? `: "${note}"` : '.'}`,
      collection,
      item: String(item),
      sender: me.id
    }).catch(() => {})
    return { data: { responded: action } }
  })
}
