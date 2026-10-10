import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { clipIssueDetails, parseRange, storeCut } from '../services/session-replay-clips.js'

/**
 * Clips of session replays.
 *
 *   POST /session-recordings/:id/clip-issue — #1366: cut the selected range
 *     into its own app='clip' recording and raise an issue on it (route at
 *     the clip's start, its console errors, the person's requests in its
 *     window, the replay link). Answers the issue id; the player opens it.
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
}
