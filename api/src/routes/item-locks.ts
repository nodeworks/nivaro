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
}

function isExpired(lock: ItemLock): boolean {
  return new Date(lock.expires_at).getTime() <= Date.now()
}

async function getCurrentLock(collection: string, item: string): Promise<ItemLock | null> {
  const lock = (await db('nivaro_item_locks').where({ collection, item }).first()) as
    | ItemLock
    | undefined
  if (!lock) return null
  if (isExpired(lock)) {
    await db('nivaro_item_locks').where({ id: lock.id }).delete()
    return null
  }
  return lock
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

    const exists = await db('nivaro_collections').where({ name: collection }).first()
    if (!exists) return reply.code(404).send({ error: 'Collection not found' })

    await db('nivaro_collections')
      .where({ name: collection })
      .update({ item_locking_enabled: item_locking_enabled ? 1 : 0 })

    // Release all active locks when disabling
    if (!item_locking_enabled) {
      await db('nivaro_item_locks').where({ collection }).delete()
      app.io?.to(`collection:${collection}`).emit('item-lock-disabled', { collection })
    }

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
    if (!lock) return reply.send({ data: null })

    return reply.send({
      data: {
        collection: lock.collection,
        item: lock.item,
        user: lock.user,
        locked_by_name: await lockHolderName(lock.user),
        locked_at: lock.locked_at,
        expires_at: lock.expires_at,
        is_mine: lock.user === req.user!.id
      }
    })
  })

  // POST /:collection/:item/lock — acquire/refresh lock for the current user
  app.post<{ Params: { collection: string; item: string } }>(
    '/:collection/:item/lock',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { collection, item } = req.params
      const me = req.user!.id

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
          expires_at: existing.expires_at
        })
      }

      const now = new Date()
      const expiresAt = new Date(now.getTime() + LOCK_TTL_MS)

      if (existing) {
        await db('nivaro_item_locks').where({ id: existing.id }).update({ expires_at: expiresAt })
      } else {
        try {
          await db('nivaro_item_locks').insert({
            collection,
            item,
            user: me,
            locked_at: now,
            expires_at: expiresAt
          })
        } catch {
          const winner = await getCurrentLock(collection, item)
          if (winner && winner.user !== me) {
            return reply.code(409).send({
              error: 'Item is locked by another user',
              locked_by: winner.user,
              locked_by_name: await lockHolderName(winner.user),
              expires_at: winner.expires_at
            })
          }
        }
      }

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
              locked_at: lock.locked_at,
              expires_at: lock.expires_at
            }
          : null
      })
    }
  )

  // POST /:collection/:item/heartbeat — extend own lock (no-op when disabled)
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
        return reply.code(404).send({ error: 'You do not hold a lock on this item' })
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
}
