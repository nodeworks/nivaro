import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { buildReplayPlan, renderPlaywrightScript } from '../services/session-replay-script.js'

type RrwebEventLike = { type: number; timestamp: number; data?: Record<string, unknown> }

/**
 * Session recording (rrweb) — opt-in, privacy-conscious screen replay.
 *
 * Recording only happens when nivaro_settings.session_recording_enabled is
 * on; the admin recorder masks all inputs client-side. Events arrive as
 * ordered JSON chunks (10s cadence) and replay by concatenation. Recordings
 * cap at MAX_BYTES (then mark truncated and refuse further chunks) and purge
 * after RETENTION_DAYS via the daily retention pass.
 */

export const RECORDING_RETENTION_DAYS = 7
const MAX_BYTES = 15_000_000 // 15MB per recording
const MAX_CHUNK = 1_500_000 // 1.5MB per chunk

export async function purgeExpiredRecordings(): Promise<void> {
  const cutoff = new Date(Date.now() - RECORDING_RETENTION_DAYS * 86_400_000)
  await db('nivaro_session_recordings').where('started_at', '<', cutoff).del()
}

async function recordingEnabled(): Promise<boolean> {
  try {
    const row = await db('nivaro_settings').where({ id: 1 }).first('session_recording_enabled')
    return !!row?.session_recording_enabled
  } catch {
    return false
  }
}

export async function sessionRecordingRoutes(app: FastifyInstance) {
  // Recorder asks whether it should run at all
  app.get('/enabled', { preHandler: requireAuth }, async (_req, reply) => {
    return reply.send({ data: { enabled: await recordingEnabled() } })
  })

  app.post<{ Body: { app?: string; origin?: string } }>(
    '/start',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!(await recordingEnabled())) {
        return reply.code(409).send({ error: 'Session recording is disabled' })
      }
      const id = randomUUID()
      const appLabel = typeof req.body?.app === 'string' ? req.body.app.slice(0, 100) : null
      // Where this happened. Taken from the client's own origin, falling back
      // to the request's host — a recording whose environment is unknown is
      // hard to act on, and the referer is the closest thing we have.
      const claimed = typeof req.body?.origin === 'string' ? req.body.origin.slice(0, 255) : ''
      const referer = typeof req.headers.referer === 'string' ? req.headers.referer : ''
      const origin =
        claimed ||
        (() => {
          try {
            return referer ? new URL(referer).origin : ''
          } catch {
            return ''
          }
        })() ||
        null
      await db('nivaro_session_recordings').insert({
        id,
        user: req.user!.id,
        app: appLabel,
        origin,
        started_at: new Date(),
        last_event_at: new Date()
      })
      return reply.send({ data: { id } })
    }
  )

  app.post<{ Params: { id: string }; Body: { seq?: number; events?: unknown[] } }>(
    '/:id/events',
    { preHandler: requireAuth, bodyLimit: 2_000_000 },
    async (req, reply) => {
      const { seq, events } = req.body ?? {}
      if (!Array.isArray(events) || events.length === 0 || typeof seq !== 'number') {
        return reply.code(400).send({ error: 'seq and events[] are required' })
      }
      const rec = (await db('nivaro_session_recordings')
        .where({ id: req.params.id })
        .first()) as
        | { id: string; user: string; byte_size: number; truncated: boolean; ended_at: Date | null }
        | undefined
      if (!rec) return reply.code(404).send({ error: 'Recording not found' })
      // Only the recording's own user appends to it
      if (rec.user !== req.user!.id) return reply.code(403).send({ error: 'Forbidden' })
      if (rec.truncated || rec.ended_at) {
        return reply.code(409).send({ error: 'Recording is closed' })
      }

      const payload = JSON.stringify(events)
      if (payload.length > MAX_CHUNK) {
        return reply.code(413).send({ error: 'Chunk too large' })
      }
      if (rec.byte_size + payload.length > MAX_BYTES) {
        await db('nivaro_session_recordings')
          .where({ id: rec.id })
          .update({ truncated: true, ended_at: new Date() })
        return reply.code(409).send({ error: 'Recording size cap reached' })
      }

      await db('nivaro_session_events').insert({
        recording: rec.id,
        seq,
        events: payload,
        created_at: new Date()
      })
      await db('nivaro_session_recordings')
        .where({ id: rec.id })
        .update({
          last_event_at: new Date(),
          event_count: db.raw('event_count + ?', [events.length]),
          byte_size: db.raw('byte_size + ?', [payload.length])
        })
      return reply.send({ data: { ok: true } })
    }
  )

  app.post<{ Params: { id: string } }>(
    '/:id/end',
    { preHandler: requireAuth },
    async (req, reply) => {
      const rec = await db('nivaro_session_recordings').where({ id: req.params.id }).first()
      if (!rec) return reply.code(404).send({ error: 'Recording not found' })
      if (rec.user !== req.user!.id && !req.isAdmin) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      await db('nivaro_session_recordings')
        .where({ id: req.params.id })
        .whereNull('ended_at')
        .update({ ended_at: new Date() })
      return reply.send({ data: { ended: true } })
    }
  )

  // ── Admin: list + replay + delete ──────────────────────────────────────────

  app.get<{ Querystring: { user?: string; page?: string } }>(
    '/',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const page = Math.max(1, Number(req.query.page) || 1)
      const limit = 50
      const q = db('nivaro_session_recordings as r')
        .leftJoin('nivaro_users as u', 'r.user', 'u.id')
        .orderBy('r.started_at', 'desc')
        .select(
          'r.id',
          'r.user',
          'r.app',
          'r.origin',
          'r.started_at',
          'r.ended_at',
          'r.last_event_at',
          'r.event_count',
          'r.byte_size',
          'r.truncated',
          db.raw(
            "LTRIM(RTRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')))) as user_name"
          )
        )
      if (req.query.user) q.where('r.user', req.query.user)
      const rows = await q.offset((page - 1) * limit).limit(limit)
      return reply.send({ data: rows, page })
    }
  )

  /**
   * The same recording as a runnable Playwright script — watch a reported
   * problem happen in a real browser instead of reading a description of it.
   * Admin-only, like every other read here: a recording is someone's session.
   */
  app.get<{ Params: { id: string } }>(
    '/:id/playwright',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const rec = (await db('nivaro_session_recordings as r')
        .leftJoin('nivaro_users as u', 'u.id', 'r.user')
        .where('r.id', req.params.id)
        .first('r.id', 'r.started_at', 'u.first_name', 'u.last_name', 'u.email')) as
        | Record<string, unknown>
        | undefined
      if (!rec) return reply.code(404).send({ error: 'Not found' })

      const chunks = (await db('nivaro_session_events')
        .where({ recording: req.params.id })
        .orderBy('seq', 'asc')
        .select('events')) as Array<{ events: string }>
      const events: RrwebEventLike[] = []
      for (const c of chunks) {
        try {
          events.push(...(JSON.parse(c.events) as RrwebEventLike[]))
        } catch {
          /* skip corrupt chunk — a partial replay beats none */
        }
      }
      if (events.length === 0) return reply.code(404).send({ error: 'No events' })

      const plan = buildReplayPlan(events)
      const who =
        [rec.first_name, rec.last_name].filter(Boolean).join(' ') || (rec.email as string) || null
      const script = renderPlaywrightScript(plan, {
        id: String(rec.id),
        user: who,
        startedAt: rec.started_at ? new Date(rec.started_at as string).toISOString() : null
      })
      await logActivity({
        action: 'session-recording-export',
        collection: 'nivaro_session_recordings',
        item: String(rec.id),
        user: req.user?.id,
        comment: `playwright script: ${plan.steps.length} step(s), ${plan.maskedInputs} masked input(s)`,
        req
      })
      return reply
        .header('content-type', 'text/plain; charset=utf-8')
        .header('content-disposition', `attachment; filename="replay-${String(rec.id).slice(0, 8)}.spec.ts"`)
        .send(script)
    }
  )

  app.get<{ Params: { id: string } }>(
    '/:id/events',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const chunks = (await db('nivaro_session_events')
        .where({ recording: req.params.id })
        .orderBy('seq', 'asc')
        .select('events')) as Array<{ events: string }>
      if (chunks.length === 0) return reply.code(404).send({ error: 'No events' })
      const events: unknown[] = []
      for (const c of chunks) {
        try {
          events.push(...(JSON.parse(c.events) as unknown[]))
        } catch {
          /* skip corrupt chunk */
        }
      }
      return reply.send({ data: { events } })
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      await db('nivaro_session_recordings').where({ id: req.params.id }).del()
      await logActivity({
        action: 'session-recording-delete',
        collection: 'nivaro_session_recordings',
        item: req.params.id,
        user: req.user?.id,
        req
      })
      return reply.send({ data: { deleted: true } })
    }
  )
}
