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

/** Fallback when the setting is unset or nonsense — the historic value. */

/**
 * Attach restrict-mode scope labels ("Zone 1", "BLT") to recording rows so an
 * admin can see WHO a replay belongs to in access terms, not just by name.
 * One batched resolve per request; decoration only — never fails the list.
 */
async function attachUserScopes(rows: Array<Record<string, unknown>>): Promise<void> {
  try {
    const ids = [...new Set(rows.map((r) => String(r.user ?? '')).filter(Boolean))]
    if (ids.length === 0) return
    const { listScopeDimensions, resolveScopeLabelsForUsers } = await import(
      '../services/user-scopes.js'
    )
    const dims = (await listScopeDimensions()).map((d) => d.name)
    if (dims.length === 0) return
    const resolved = await resolveScopeLabelsForUsers(ids, dims)
    const byUpper = new Map<string, Map<string, string[]>>()
    for (const [uid, perDim] of resolved) byUpper.set(uid.toUpperCase(), perDim)
    for (const r of rows) {
      const perDim = byUpper.get(String(r.user ?? '').toUpperCase())
      if (!perDim) continue
      const labels: string[] = []
      for (const vals of perDim.values()) labels.push(...vals)
      if (labels.length > 0) r.scopes = labels
    }
  } catch {
    // Scope labels are decoration — never fail the recordings list over them.
  }
}

export const RECORDING_RETENTION_DAYS = 7

/**
 * Days to keep recordings, from settings.
 *
 * Clamped to 1–365: zero would delete a recording the moment it was made, and
 * an unbounded value turns a debugging aid into an archive of people working,
 * which is the thing a retention setting exists to prevent.
 */
export async function recordingRetentionDays(): Promise<number> {
  try {
    const row = await db('nivaro_settings')
      .where({ id: 1 })
      .first('session_recording_retention_days')
    const n = Number(row?.session_recording_retention_days)
    if (!Number.isFinite(n) || n <= 0) return RECORDING_RETENTION_DAYS
    return Math.min(Math.max(Math.trunc(n), 1), 365)
  } catch {
    return RECORDING_RETENTION_DAYS
  }
}
const MAX_BYTES = 15_000_000 // 15MB per recording
const MAX_CHUNK = 1_500_000 // 1.5MB per chunk

/** '__none__' in the comma list means rows with no recorded origin. */
function parseOrigins(raw: string | undefined): { list: string[]; includeNull: boolean } {
  const parts = String(raw ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 20)
  return { list: parts.filter((v) => v !== '__none__'), includeNull: parts.includes('__none__') }
}

function originsClause(raw: string | undefined): { clause: string; binds: string[] } {
  if (!raw) return { clause: '', binds: [] }
  const { list, includeNull } = parseOrigins(raw)
  const parts: string[] = []
  if (list.length > 0) parts.push(`r.origin IN (${list.map(() => '?').join(',')})`)
  if (includeNull) parts.push('r.origin IS NULL')
  if (parts.length === 0) return { clause: '', binds: [] }
  return { clause: `WHERE ${parts.join(' OR ')}`, binds: list }
}

export async function purgeExpiredRecordings(): Promise<void> {
  const days = await recordingRetentionDays()
  const cutoff = new Date(Date.now() - days * 86_400_000)
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
    const row = await db('nivaro_settings')
      .where({ id: 1 })
      .first('session_recording_enabled', 'error_replay_enabled')
    return reply.send({
      data: {
        enabled: !!row?.session_recording_enabled,
        // Error-clip buffer mode: record into a rolling in-memory buffer,
        // upload only when an error is reported (see migration 210).
        error_replay: !!(row as { error_replay_enabled?: unknown } | undefined)
          ?.error_replay_enabled
      }
    })
  })

  app.post<{ Body: { app?: string; origin?: string; clip?: boolean } }>(
    '/start',
    { preHandler: requireAuth },
    async (req, reply) => {
      // A clip start is gated by the error-replay bit, not the full-recording
      // bit — clips exist precisely so operators can keep continuous
      // recording OFF and still get the last minute before an error.
      const isClip = req.body?.clip === true
      if (isClip) {
        const row = await db('nivaro_settings').where({ id: 1 }).first('error_replay_enabled')
        if (!(row as { error_replay_enabled?: unknown } | undefined)?.error_replay_enabled) {
          return reply.code(409).send({ error: 'Error replay is disabled' })
        }
      } else if (!(await recordingEnabled())) {
        return reply.code(409).send({ error: 'Session recording is disabled' })
      }
      const id = randomUUID()
      const appLabel = isClip
        ? 'error-clip'
        : typeof req.body?.app === 'string'
          ? req.body.app.slice(0, 100)
          : null
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
      const rec = (await db('nivaro_session_recordings').where({ id: req.params.id }).first()) as
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

  /**
   * People aggregate — the rail must reflect EVERYONE with recordings, not
   * whoever owns the newest 50 rows: one heavy recorder (dev automation, a
   * power user) previously flooded the first page and every other person
   * "disappeared" from the list.
   */
  app.get<{ Querystring: { origins?: string } }>(
    '/people',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { clause, binds } = originsClause(req.query.origins)
      const rows = (await db.raw(
        `SELECT r.[user] AS [user],
                LTRIM(RTRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')))) AS user_name,
                COUNT(*) AS recording_count,
                SUM(CAST(r.byte_size AS BIGINT)) AS total_bytes,
                MAX(COALESCE(r.last_event_at, r.started_at)) AS last_active,
                MAX(CASE WHEN r.ended_at IS NULL AND r.last_event_at > DATEADD(minute, -2, GETUTCDATE()) THEN 1 ELSE 0 END) AS live
         FROM nivaro_session_recordings r
         LEFT JOIN nivaro_users u ON u.id = r.[user]
         ${clause}
         GROUP BY r.[user], u.first_name, u.last_name
         ORDER BY last_active DESC`,
        binds
      )) as Array<Record<string, unknown>>
      return reply.send({ data: rows })
    }
  )

  /** Distinct recording origins with counts — feeds the environment filter. */
  app.get('/origins', { preHandler: requireAdmin }, async (_req, reply) => {
    const rows = await db('nivaro_session_recordings')
      .groupBy('origin')
      .count({ c: '*' })
      .select('origin')
    return reply.send({ data: rows })
  })

  app.get<{ Querystring: { user?: string; page?: string; origins?: string } }>(
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
      if (req.query.origins) {
        const { list, includeNull } = parseOrigins(req.query.origins)
        q.where((qb) => {
          if (list.length > 0) qb.whereIn('r.origin', list)
          if (includeNull) {
            if (list.length > 0) qb.orWhereNull('r.origin')
            else qb.whereNull('r.origin')
          }
        })
      }
      const rows = await q.offset((page - 1) * limit).limit(limit)
      await attachUserScopes(rows)
      return reply.send({ data: rows, page })
    }
  )

  /**
   * One recording's header row, list-shape. The deep link ("Watch replay of
   * this error", the chat online list) must play a recording even when it is
   * off the first page or hidden by the list's filters — matching only
   * against loaded rows silently landed on the bare list.
   */
  app.get<{ Params: { id: string } }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const rec = (await db('nivaro_session_recordings as r')
      .leftJoin('nivaro_users as u', 'r.user', 'u.id')
      .where('r.id', req.params.id)
      .first(
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
      )) as Record<string, unknown> | undefined
    if (!rec) return reply.code(404).send({ error: 'Not found' })
    await attachUserScopes([rec])
    return reply.send({ data: rec })
  })

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
        .header(
          'content-disposition',
          `attachment; filename="replay-${String(rec.id).slice(0, 8)}.spec.ts"`
        )
        .send(script)
    }
  )

  app.get<{ Params: { id: string }; Querystring: { after_seq?: string } }>(
    '/:id/events',
    { preHandler: requireAdmin },
    async (req, reply) => {
      // ?after_seq= powers live-follow: the player fetches only chunks newer
      // than what it already holds and feeds them into a liveMode Replayer.
      const afterSeq = Number(req.query?.after_seq)
      const incremental = Number.isFinite(afterSeq)
      const chunks = (await db('nivaro_session_events')
        .where({ recording: req.params.id })
        .modify((qb) => {
          if (incremental) qb.where('seq', '>', afterSeq)
        })
        .orderBy('seq', 'asc')
        .select('seq', 'events')) as Array<{ seq: number; events: string }>
      if (chunks.length === 0) {
        // Incremental polls with nothing new are a normal empty answer.
        if (incremental) return reply.send({ data: { events: [], last_seq: afterSeq } })
        return reply.code(404).send({ error: 'No events' })
      }
      const events: unknown[] = []
      for (const c of chunks) {
        try {
          events.push(...(JSON.parse(c.events) as unknown[]))
        } catch {
          /* skip corrupt chunk */
        }
      }
      return reply.send({ data: { events, last_seq: chunks[chunks.length - 1].seq } })
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
