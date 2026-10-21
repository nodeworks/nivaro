import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { canSeeRoom } from '../services/chat.js'
import { type HuddleRedis, huddlePeers, huddleRoomKind } from '../services/huddle.js'
import {
  cancelHuddleSchedule,
  createHuddleSchedule,
  getScheduleRow,
  hasSchedulesTable,
  parseScheduleInput,
  roomSchedules,
  scheduleCard
} from '../services/huddle-schedule.js'
import { currentTenantKey } from '../services/tenant-rooms.js'
import type { User } from '../types.js'

/**
 * Calls and scheduled huddles (#2844, #2860) over REST — registered under
 * /chat/huddle beside chat-huddle.ts:
 *   GET    /people?room=&q=     people who could be added to the room's huddle: a name
 *                               search over active accounts, each one checked with
 *                               canSeeRoom for THAT room — nobody else is ever listed
 *   GET    /schedules?room=     the room's upcoming huddles (canSeeRoom)
 *   POST   /schedules           make one {room, title, starts_at, duration_min, invitees}
 *   GET    /schedules/:id       the card (canSeeRoom on its room)
 *   DELETE /schedules/:id       cancel (organizer or an administrator)
 */
export async function chatHuddleCallRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  const notFound = { error: 'Not found' }

  app.get('/people', async (req, reply) => {
    const q = req.query as { room?: string; q?: string }
    const room = String(q.room ?? '')
    if (huddleRoomKind(room) !== 'ok') return reply.code(404).send(notFound)
    if (!(await canSeeRoom(req.user!, room))) return reply.code(404).send(notFound)
    const search = String(q.q ?? '')
      .replace(/[%_]/g, '')
      .trim()
      .slice(0, 80)
    let query = db('nivaro_users')
      .where('status', 'active')
      .whereNull('account_kind')
      .whereNot('id', req.user!.id)
      .select('id', 'first_name', 'last_name', 'email', 'title')
      .orderBy('first_name')
      .orderBy('last_name')
      .limit(25)
    // Every word typed must match a name part or the email ("rob le" finds Rob Lee).
    for (const word of search.split(/\s+/).filter(Boolean).slice(0, 4)) {
      const like = `%${word}%`
      query = query.where((qb) => {
        qb.where('first_name', 'like', like)
          .orWhere('last_name', 'like', like)
          .orWhere('email', 'like', like)
      })
    }
    const rows = (await query) as User[]
    const peers = await huddlePeers(
      app.redis as unknown as HuddleRedis,
      currentTenantKey() || null,
      room
    ).catch(() => [])
    const inHuddle = new Set(peers.map((p) => String(p.user).toUpperCase()))
    const out: Array<{ id: string; name: string; title: string | null; in_huddle: boolean }> = []
    for (const u of rows) {
      // The gate: only people who can see the room themselves.
      if (!(await canSeeRoom(u, room).catch(() => false))) continue
      out.push({
        id: String(u.id),
        name: [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email,
        title: u.title ?? null,
        in_huddle: inHuddle.has(String(u.id).toUpperCase())
      })
    }
    return reply.send({ data: out })
  })

  app.get('/schedules', async (req, reply) => {
    const room = String((req.query as { room?: string }).room ?? '')
    if (huddleRoomKind(room) !== 'ok') return reply.send({ data: [] })
    if (!(await canSeeRoom(req.user!, room))) return reply.code(404).send(notFound)
    const rows = await roomSchedules(room)
    const cards = []
    for (const r of rows) {
      const c = await scheduleCard(app, r.id, req.user!, !!req.isAdmin)
      if (c) cards.push(c)
    }
    return reply.send({ data: cards })
  })

  app.post('/schedules', async (req, reply) => {
    if (!(await hasSchedulesTable()))
      return reply.code(503).send({ error: 'Scheduled huddles need migration 495' })
    const parsed = parseScheduleInput(req.body)
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error })
    if (!(await canSeeRoom(req.user!, parsed.value.room))) return reply.code(404).send(notFound)
    const card = await createHuddleSchedule(app, req.user!, parsed.value)
    await logActivity({
      action: 'create',
      collection: 'nivaro_chat_huddle_schedules',
      item: String(card.id),
      user: req.user?.id,
      req,
      comment: `Scheduled huddle "${card.title}" in ${card.room} at ${card.starts_at}`
    })
    return reply.code(201).send({ data: card })
  })

  app.get<{ Params: { id: string } }>('/schedules/:id', async (req, reply) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return reply.code(404).send(notFound)
    const row = await getScheduleRow(id)
    if (!row || !(await canSeeRoom(req.user!, row.room))) return reply.code(404).send(notFound)
    const card = await scheduleCard(app, id, req.user!, !!req.isAdmin)
    return card ? reply.send({ data: card }) : reply.code(404).send(notFound)
  })

  app.delete<{ Params: { id: string } }>('/schedules/:id', async (req, reply) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return reply.code(404).send(notFound)
    const row = await getScheduleRow(id)
    if (!row || !(await canSeeRoom(req.user!, row.room))) return reply.code(404).send(notFound)
    const ok = await cancelHuddleSchedule(app, id, req.user!, !!req.isAdmin)
    if (!ok)
      return reply.code(403).send({ error: 'Only the organizer or an administrator can cancel it' })
    await logActivity({
      action: 'delete',
      collection: 'nivaro_chat_huddle_schedules',
      item: String(id),
      user: req.user?.id,
      req,
      comment: `Cancelled huddle "${row.title}"`
    })
    return reply.send({ data: { cancelled: true } })
  })
}
