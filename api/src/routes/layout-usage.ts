import type { FastifyInstance } from 'fastify'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import {
  collectionCoChanges,
  KEEP_DAYS,
  layoutCollection,
  layoutFriction,
  recordUsage,
  sanitizeUsageEvent,
  usageTablesReady,
  usageToday
} from '../services/layout-usage.js'
import { can } from '../services/permissions.js'

/**
 * Form usage per layout (#2597/#2598/#2605) — see services/layout-usage.ts.
 * Deliberately NOT under /collection-layouts: the beacon is a write, and any
 * write under a metadata route would flush the metadata caches tenant-wide
 * (config-write hook) on every form close.
 */
export async function layoutUsageRoutes(app: FastifyInstance) {
  // The record form's session events (sendBeacon / keepalive fetch on close),
  // batched: { events: [...] }, at most 20. Fire and forget: always 204.
  app.post<{ Body: { events?: unknown[] } }>(
    '/beacon',
    { preHandler: authenticate, bodyLimit: 64 * 1024 },
    async (req, reply) => {
      const user = req.user
      const raw = Array.isArray(req.body?.events) ? req.body.events.slice(0, 20) : []
      if (!user || raw.length === 0 || !(await usageTablesReady())) return reply.code(204).send()
      const allowed = new Map<string, boolean>()
      for (const r of raw) {
        const ev = sanitizeUsageEvent(r)
        if (!ev) continue
        try {
          // The layout must exist and belong to the collection the event names,
          // and the sender must be able to read that collection.
          if ((await layoutCollection(ev.layout_id)) !== ev.collection) continue
          if (!allowed.has(ev.collection))
            allowed.set(ev.collection, await can(user, 'read', ev.collection))
          if (!allowed.get(ev.collection)) continue
          await recordUsage(ev, user.id ?? null)
        } catch (err) {
          req.log.warn({ err, layout_id: ev.layout_id }, 'layout usage beacon not stored')
        }
      }
      return reply.code(204).send()
    }
  )

  // Record-page Edit layout banner: people and records that used the form today (UTC day).
  app.get<{ Params: { id: string } }>(
    '/:id/today',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'Invalid id' })
      return { data: await usageToday(id) }
    }
  )

  // Friction panel: time per step, abandons by step, fields changed after save.
  app.get<{ Params: { id: string }; Querystring: { days?: string } }>(
    '/:id/friction',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'Invalid id' })
      const collection = await layoutCollection(id)
      if (!collection) return reply.code(404).send({ error: 'Layout not found' })
      const days = Math.max(1, Math.min(KEEP_DAYS, Number(req.query.days) || 30))
      return { data: await layoutFriction(id, collection, req.user?.id, days) }
    }
  )

  // Suggested sections: fields people change in the same save.
  app.get<{ Params: { collection: string } }>(
    '/co-changes/:collection',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { collection } = req.params
      if (
        !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(collection) ||
        /^nivaro_|^directus_/i.test(collection)
      )
        return reply.code(400).send({ error: 'Invalid collection' })
      return { data: await collectionCoChanges(collection, req.user?.id) }
    }
  )
}
