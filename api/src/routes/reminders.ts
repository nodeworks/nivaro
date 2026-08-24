import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'

// Reminders manager (#259): the chat bot's set_reminder tool writes
// nivaro_reminders (migration 214) and the chat-reminders cron delivers them —
// but there was no way to see, edit, or cancel one, and no way to create one
// without the bot. Own-rows-only CRUD; delivery stays the existing cron.

interface ReminderRow {
  id: number
  user: string
  note: string
  room: string | null
  remind_at: Date
  sent: number | boolean
}

export async function remindersRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // GET / — own reminders, upcoming first; ?include_sent=true adds history
  app.get<{ Querystring: { include_sent?: string } }>('/', async (req, reply) => {
    let q = db('nivaro_reminders').where({ user: req.user!.id })
    if (req.query.include_sent !== 'true') q = q.where('sent', 0)
    const rows = (await q.orderBy('remind_at', 'asc').limit(200)) as ReminderRow[]
    return reply.send({ data: rows })
  })

  // POST / — create without the bot
  app.post<{ Body: { note?: string; remind_at?: string } }>('/', async (req, reply) => {
    const note = String(req.body?.note ?? '').trim()
    const at = req.body?.remind_at ? new Date(req.body.remind_at) : null
    if (!note) return reply.code(400).send({ error: 'note is required' })
    if (!at || Number.isNaN(at.getTime())) {
      return reply.code(400).send({ error: 'remind_at must be a valid datetime' })
    }
    if (at.getTime() < Date.now() - 60_000) {
      return reply.code(400).send({ error: 'remind_at is in the past' })
    }
    await db('nivaro_reminders').insert({
      user: req.user!.id,
      note: note.slice(0, 1000),
      room: null,
      remind_at: at,
      sent: 0
    })
    const row = (await db('nivaro_reminders')
      .where({ user: req.user!.id })
      .orderBy('id', 'desc')
      .first()) as ReminderRow
    return reply.code(201).send({ data: row })
  })

  // PATCH /:id — edit note/time on an UNSENT own reminder
  app.patch<{ Params: { id: string }; Body: { note?: string; remind_at?: string } }>(
    '/:id',
    async (req, reply) => {
      const row = (await db('nivaro_reminders')
        .where({ id: Number(req.params.id), user: req.user!.id })
        .first()) as ReminderRow | undefined
      if (!row) return reply.code(404).send({ error: 'Reminder not found' })
      if (row.sent) return reply.code(400).send({ error: 'Reminder was already delivered' })
      const patch: Record<string, unknown> = {}
      if (req.body?.note !== undefined) {
        const note = String(req.body.note).trim()
        if (!note) return reply.code(400).send({ error: 'note cannot be empty' })
        patch.note = note.slice(0, 1000)
      }
      if (req.body?.remind_at !== undefined) {
        const at = new Date(String(req.body.remind_at))
        if (Number.isNaN(at.getTime())) {
          return reply.code(400).send({ error: 'remind_at must be a valid datetime' })
        }
        patch.remind_at = at
      }
      if (Object.keys(patch).length > 0) {
        await db('nivaro_reminders').where({ id: row.id }).update(patch)
      }
      const updated = await db('nivaro_reminders').where({ id: row.id }).first()
      return reply.send({ data: updated })
    }
  )

  // DELETE /:id — cancel an own reminder (sent rows deletable too — history cleanup)
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const n = await db('nivaro_reminders')
      .where({ id: Number(req.params.id), user: req.user!.id })
      .del()
    if (!n) return reply.code(404).send({ error: 'Reminder not found' })
    return reply.code(204).send()
  })
}
