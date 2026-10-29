import type { FastifyInstance } from 'fastify'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { readItems, readOne } from '../services/items.js'
import { abArmOf, abTestsForCollection } from '../services/layout-ab.js'
import { roleAllows } from '../services/layout-patch.js'
import {
  collectionCoChanges,
  KEEP_DAYS,
  layoutCollection,
  layoutFriction,
  layoutRefusals,
  layoutUsageInfo,
  recordUsage,
  sanitizeUsageEvent,
  type UsageEvent,
  usageTablesReady,
  usageToday
} from '../services/layout-usage.js'
import { can } from '../services/permissions.js'
import { takeWindowed } from '../services/windowed-limit.js'
import type { User } from '../types.js'

const BEACON_MAX = 20
const BEACON_PER_MIN = 60
const KEY_SHAPE = /^(\d{1,18}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/**
 * The `collection\0item` refs among `events` the user can read: one permission-checked
 * list read per collection for key-shaped refs (RLS + User Scopes apply), readOne for an
 * alias-shaped one. A read that fails answers "not readable".
 */
async function readableItemRefs(user: User, events: UsageEvent[]): Promise<Set<string>> {
  const byCollection = new Map<string, Set<string>>()
  for (const ev of events) {
    if (ev.item == null) continue
    const refs = byCollection.get(ev.collection) ?? new Set<string>()
    refs.add(ev.item)
    byCollection.set(ev.collection, refs)
  }
  const out = new Set<string>()
  for (const [collection, refs] of byCollection) {
    const keys = [...refs].filter((r) => KEY_SHAPE.test(r))
    if (keys.length > 0) {
      try {
        const res = (await readItems(user, collection, {
          fields: ['id'],
          filter: { id: { _in: keys } },
          limit: keys.length,
          count: false
        })) as { data?: Array<Record<string, unknown>> }
        const found = new Set((res.data ?? []).map((r) => String(r.id).toLowerCase()))
        for (const k of keys) if (found.has(k.toLowerCase())) out.add(`${collection}\u0000${k}`)
      } catch {
        /* not readable */
      }
    }
    for (const ref of refs) {
      if (KEY_SHAPE.test(ref)) continue
      try {
        if (await readOne(user, collection, ref, undefined, ['id']))
          out.add(`${collection}\u0000${ref}`)
      } catch {
        /* not readable */
      }
    }
  }
  return out
}

/**
 * Form usage per layout (#2597/#2598/#2605) — see services/layout-usage.ts.
 * Deliberately NOT under /collection-layouts: the beacon is a write, and any
 * write under a metadata route would flush the metadata caches tenant-wide
 * (config-write hook) on every form close.
 */
export async function layoutUsageRoutes(app: FastifyInstance) {
  // The record form's session events (sendBeacon / keepalive fetch on close),
  // batched: { events: [...] }, at most 20. Fire and forget: always 204.
  // Each person may store BEACON_PER_MIN events a minute (cluster-wide); an event counts
  // only when its layout is open to the sender's role and its record (if any) is one the
  // sender can read — anything else is dropped, never an error for the whole batch.
  app.post<{ Body: { events?: unknown[] } }>(
    '/beacon',
    { preHandler: authenticate, bodyLimit: 64 * 1024 },
    async (req, reply) => {
      const user = req.user
      const raw = Array.isArray(req.body?.events) ? req.body.events.slice(0, BEACON_MAX) : []
      if (!user || raw.length === 0 || !(await usageTablesReady())) return reply.code(204).send()
      const events = raw.flatMap((r) => sanitizeUsageEvent(r) ?? [])
      const granted = await takeWindowed(
        app.redis,
        `layout-usage:${String(user.id)}`,
        events.length,
        BEACON_PER_MIN,
        60
      )
      const allowed = new Map<string, boolean>()
      const accepted: UsageEvent[] = []
      for (const ev of events.slice(0, granted)) {
        try {
          // The layout must exist, belong to the collection the event names and be open to
          // the sender's role, and the sender must be able to read that collection.
          const info = await layoutUsageInfo(ev.layout_id)
          if (!info || info.collection !== ev.collection) continue
          if (!roleAllows(info, user.role ?? null, !!req.isAdmin)) continue
          if (!allowed.has(ev.collection))
            allowed.set(ev.collection, await can(user, 'read', ev.collection))
          if (!allowed.get(ev.collection)) continue
          accepted.push(ev)
        } catch (err) {
          req.log.warn({ err, layout_id: ev.layout_id }, 'layout usage beacon not stored')
        }
      }
      const readable = await readableItemRefs(user, accepted)
      for (const ev of accepted) {
        if (ev.item != null && !readable.has(`${ev.collection}\u0000${ev.item}`)) continue
        // A session in an A/B test (#2614) also counts for that test's half. The arm is
        // best-effort: a failed lookup still stores the plain usage row.
        let arm: ReturnType<typeof abArmOf> = null
        try {
          arm = abArmOf(
            await abTestsForCollection(ev.collection),
            ev.layout_id,
            user,
            !!req.isAdmin
          )
        } catch (err) {
          req.log.warn({ err, layout_id: ev.layout_id }, 'layout usage A/B arm lookup failed')
        }
        try {
          await recordUsage(ev, user.id ?? null, arm)
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

  // Where saves fail (#3185): refused saves per field — the editor's error-rate lens.
  app.get<{ Params: { id: string }; Querystring: { days?: string } }>(
    '/:id/refusals',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'Invalid id' })
      if (!(await layoutCollection(id))) return reply.code(404).send({ error: 'Layout not found' })
      const days = Math.max(1, Math.min(KEEP_DAYS, Number(req.query.days) || 30))
      return { data: await layoutRefusals(id, req.user?.id, days) }
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
