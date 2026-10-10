import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  clipIssueDetails,
  parseRange,
  parseTags,
  storeCut
} from '../services/session-replay-clips.js'
import { deleteColdObject } from '../services/session-replay-storage.js'

/**
 * Clips of session replays.
 *
 *   POST /session-recordings/:id/clip-issue — #1366: cut the selected range
 *     into its own app='clip' recording and raise an issue on it (route at
 *     the clip's start, its console errors, the person's requests in its
 *     window, the replay link). Answers the issue id; the player opens it.
 *
 *   POST   /session-recordings/:id/clips — #1415: save the range to the
 *     library as a named, described, tagged clip (cut the same way; the
 *     cut is exempt from retention while the library row exists).
 *   GET    /session-replay-clips?q=&tag= — the library, newest first;
 *     q searches name, description and tags.
 *   DELETE /session-replay-clips/:id — remove the clip and its cut.
 *
 * Admin-only like every recording read: a recording is someone's session.
 * Registered without a prefix (full paths) so it sits beside the recordings
 * routes without touching their plugin.
 */

const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const

async function personName(userId: string): Promise<string | null> {
  try {
    const u = (await db('nivaro_users')
      .where({ id: userId })
      .first('first_name', 'last_name', 'email')) as
      | { first_name?: string | null; last_name?: string | null; email?: string | null }
      | undefined
    if (!u) return null
    return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || null
  } catch {
    return null
  }
}

interface ClipRow {
  id: string
  name: string
  description: string | null
  tags: string | null
  recording: string
  source_recording: string | null
  from_ms: number
  to_ms: number
  saved_by: string | null
  created_at: Date | string
  [k: string]: unknown
}

/** A library row as the client reads it: tags as an array. */
function clipOut(row: ClipRow) {
  let tags: string[] = []
  try {
    const v = row.tags ? JSON.parse(row.tags) : []
    if (Array.isArray(v)) tags = v.map(String)
  } catch {
    /* a hand-edited row: no tags */
  }
  return { ...row, tags, duration_ms: Math.max(0, Number(row.to_ms) - Number(row.from_ms)) }
}

/** "First Last" of a joined nivaro_users alias, as `as`. */
const nameOf = (alias: 'u' | 'sb', as: string) =>
  db.raw(
    `LTRIM(RTRIM(CONCAT(COALESCE(${alias}.first_name, ''), ' ', COALESCE(${alias}.last_name, '')))) as ${as}`
  )

/** `%text%` for LIKE; wildcards in the text (SQL Server's `[` included) are dropped. */
const contains = (v: string) => `%${v.replace(/[%_[\]]/g, '')}%`

export async function sessionReplayClipRoutes(app: FastifyInstance) {
  app.post<{
    Params: { id: string }
    Body: { from_ms?: number; to_ms?: number; title?: string; note?: string; severity?: string }
  }>('/session-recordings/:id/clip-issue', { preHandler: requireAdmin }, async (req, reply) => {
    const range = parseRange(req.body)
    if (!range) {
      return reply.code(400).send({ error: 'from_ms and to_ms are required, at least 1 s apart' })
    }
    const body = req.body ?? {}
    const severity = body.severity ?? 'medium'
    if (!SEVERITIES.includes(severity as never)) {
      return reply.code(400).send({ error: `severity must be one of ${SEVERITIES.join(', ')}` })
    }
    const stored = await storeCut(req.params.id, range.fromMs, range.toMs)
    if ('status' in stored) return reply.code(stored.status).send({ error: stored.error })

    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null
    const info = await clipIssueDetails(stored, note, await personName(stored.source.user))
    const title =
      (typeof body.title === 'string' && body.title.trim()) ||
      `Replay clip: ${info.route ?? 'unknown route'}${info.errorCount > 0 ? ` (${info.errorCount} console error${info.errorCount === 1 ? '' : 's'})` : ''}`
    const now = new Date()
    const inserted = (await db('nivaro_issues')
      .insert({
        title: title.slice(0, 500),
        severity,
        status: 'open',
        collection: null,
        item: null,
        details: info.details,
        source: 'manual',
        raised_by: req.user!.id,
        // The whole clip is the context: it opens at its first instant.
        recording_id: stored.recordingId,
        recording_offset_ms: 0,
        created_at: now,
        updated_at: now
      })
      .returning('id')) as unknown[]
    // `.returning('id')` yields an object on this stack, a bare id elsewhere.
    const first = inserted[0] as { id?: unknown } | number | undefined
    const issueId = Number(typeof first === 'object' && first ? first.id : first)

    await logActivity({
      action: 'session-replay-clip-issue',
      collection: 'nivaro_issues',
      item: String(issueId),
      user: req.user?.id,
      comment: `clip ${stored.recordingId} of recording ${stored.source.id} (${Math.round(stored.cut.fromMs)}–${Math.round(stored.cut.toMs)} ms)`,
      req
    })
    return reply.code(201).send({
      data: {
        issue_id: issueId,
        recording_id: stored.recordingId,
        from_ms: stored.cut.fromMs,
        to_ms: stored.cut.toMs,
        route: info.route,
        console_errors: info.errorCount,
        requests: info.requestCount
      }
    })
  })

  // ── Library (#1415) ────────────────────────────────────────────────────────

  app.post<{
    Params: { id: string }
    Body: { from_ms?: number; to_ms?: number; name?: string; description?: string; tags?: unknown }
  }>('/session-recordings/:id/clips', { preHandler: requireAdmin }, async (req, reply) => {
    const range = parseRange(req.body)
    if (!range) {
      return reply.code(400).send({ error: 'from_ms and to_ms are required, at least 1 s apart' })
    }
    const body = req.body ?? {}
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : ''
    if (!name) return reply.code(400).send({ error: 'name is required' })
    const description =
      typeof body.description === 'string' && body.description.trim()
        ? body.description.trim().slice(0, 2000)
        : null
    const tags = parseTags(body.tags)

    const stored = await storeCut(req.params.id, range.fromMs, range.toMs)
    if ('status' in stored) return reply.code(stored.status).send({ error: stored.error })

    const id = randomUUID()
    const row: ClipRow = {
      id,
      name,
      description,
      tags: tags.length > 0 ? JSON.stringify(tags) : null,
      recording: stored.recordingId,
      source_recording: stored.source.id,
      from_ms: Math.round(stored.cut.fromMs),
      to_ms: Math.round(stored.cut.toMs),
      saved_by: req.user!.id,
      created_at: new Date()
    }
    await db('nivaro_replay_clips').insert(row)
    await logActivity({
      action: 'session-replay-clip-save',
      collection: 'nivaro_replay_clips',
      item: id,
      user: req.user?.id,
      comment: `"${name}" from recording ${stored.source.id} (${row.from_ms}–${row.to_ms} ms)`,
      req
    })
    return reply.code(201).send({ data: clipOut(row) })
  })

  app.get<{ Querystring: { q?: string; tag?: string } }>(
    '/session-replay-clips',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const q = String(req.query.q ?? '')
        .trim()
        .slice(0, 100)
        .toLowerCase()
      const tag = String(req.query.tag ?? '')
        .trim()
        .slice(0, 40)
        .toLowerCase()
      const rows = (await db('nivaro_replay_clips as c')
        .leftJoin('nivaro_session_recordings as r', 'r.id', 'c.recording')
        .leftJoin('nivaro_users as u', 'u.id', 'r.user')
        .leftJoin('nivaro_users as sb', 'sb.id', 'c.saved_by')
        .modify((qb) => {
          if (q) {
            const pattern = contains(q)
            qb.where((w) => {
              w.whereRaw('LOWER(c.name) LIKE ?', [pattern])
                .orWhereRaw("LOWER(COALESCE(c.description, '')) LIKE ?", [pattern])
                .orWhereRaw("LOWER(COALESCE(c.tags, '')) LIKE ?", [pattern])
            })
          }
          // Tags are stored as a JSON array: match the quoted element.
          if (tag) {
            qb.whereRaw("LOWER(COALESCE(c.tags, '')) LIKE ?", [contains(JSON.stringify(tag))])
          }
        })
        .orderBy('c.created_at', 'desc')
        .limit(200)
        .select(
          'c.id',
          'c.name',
          'c.description',
          'c.tags',
          'c.recording',
          'c.source_recording',
          'c.from_ms',
          'c.to_ms',
          'c.saved_by',
          'c.created_at',
          'r.user',
          'r.origin',
          'r.started_at',
          nameOf('u', 'user_name'),
          nameOf('sb', 'saved_by_name')
        )) as ClipRow[]
      return reply.send({ data: rows.map(clipOut) })
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/session-replay-clips/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const clip = (await db('nivaro_replay_clips')
        .where({ id: req.params.id })
        .first('id', 'name', 'recording')) as
        | { id: string; name: string; recording: string }
        | undefined
      if (!clip) return reply.code(404).send({ error: 'Clip not found' })
      // The cut goes with it (its events and the library row cascade).
      // #1411 — a clip that went cold takes its stored object with it.
      await deleteColdObject(clip.recording)
      await db('nivaro_session_recordings').where({ id: clip.recording }).del()
      await logActivity({
        action: 'session-replay-clip-delete',
        collection: 'nivaro_replay_clips',
        item: clip.id,
        user: req.user?.id,
        comment: `"${clip.name}"`,
        req
      })
      return reply.send({ data: { deleted: true } })
    }
  )
}
