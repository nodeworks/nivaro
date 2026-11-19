import type { FastifyInstance } from 'fastify'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { loadTimelineSlot } from '../services/overview/data.js'
import { parseDayStart } from '../services/overview/model.js'
import { enrichSlotMarks } from '../services/overview/slot.js'
import { loadTodayPeople, loadTodayRecords, sheetWindow } from '../services/overview/today.js'
import { withReadGate } from '../services/read-gate.js'
import type { User } from '../types.js'

/**
 * The Overview "Today" strip's drill sheets (route `/`, `?today=…`). Each reads the same source
 * as its figure over the figure's own window (`day_start` → `until` = the figure's computed_at),
 * so the sheet lists the number on the tile.
 *
 *   GET /overview/today/records?day_start=&until=&collection=&person=&offset=&limit=
 *        signed in; as the viewer (administrators every record change, others only records
 *        they can read). → {data: TodayRecords}
 *   GET /overview/today/people?day_start=&until=      administrators. → {data: {people, total}}
 *   GET /overview/timeline/slot?start=<slot start>    administrators: every mark in one slot,
 *        each with its details (services/overview/slot.ts: job, duration, first error line,
 *        who started it / who changed the config) so the sheet can fold, filter and sort
 */
const COLLECTION_RE = /^[A-Za-z0-9_]{1,64}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function overviewTodayRoutes(app: FastifyInstance): Promise<void> {
  app.get('/today/records', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user as User
    const isAdmin = !!req.isAdmin && !user.api_key_scopes
    const q = req.query as Record<string, string | undefined>
    const now = new Date()
    const window = sheetWindow(parseDayStart(q.day_start, now), q.until, now)
    const collection = q.collection && COLLECTION_RE.test(q.collection) ? q.collection : null
    if (q.collection && !collection)
      return reply.code(400).send({ error: '`collection` is not valid' })
    const person = q.person && UUID_RE.test(q.person) ? q.person : null
    if (q.person && !person) return reply.code(400).send({ error: '`person` must be a user id' })
    const data = await withReadGate(
      String(user.id),
      () =>
        loadTodayRecords(user, {
          isAdmin,
          window,
          collection,
          person,
          offset: Number(q.offset) || 0,
          limit: Number(q.limit) || 50
        }),
      { label: 'overview-today-records' }
    )
    return { data }
  })

  app.get('/today/people', { preHandler: requireAdmin }, async (req) => {
    const q = req.query as Record<string, string | undefined>
    const now = new Date()
    const window = sheetWindow(parseDayStart(q.day_start, now), q.until, now)
    const data = await withReadGate(req.user?.id, () => loadTodayPeople(window), {
      label: 'overview-today-people'
    })
    return { data }
  })

  app.get('/timeline/slot', { preHandler: requireAdmin }, async (req, reply) => {
    const start = String((req.query as { start?: string }).start ?? '')
    const slot = await loadTimelineSlot(start)
    if (!slot)
      return reply
        .code(404)
        .send({ error: 'That slot is no longer on the timeline', code: 'SLOT_GONE' })
    const registry = (app.cron?.list() ?? []).map((j) => ({
      id: j.id,
      extensionId: j.extensionId,
      description: j.description
    }))
    // Primary-key reads of the slot's own runs and entries: cheap, so not gated.
    const marks = await enrichSlotMarks(slot.marks, registry)
    return { data: { ...slot, marks } }
  })
}
