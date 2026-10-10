import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { loadRecordingEvents } from '../services/session-replay-events.js'
import { fmtClock, loadRecordingHeader } from '../services/session-replay-export.js'
import { buildSpecPlan } from '../services/session-replay-spec.js'

/**
 * A Playwright spec from a recording (#1393). Admin-only, like every read of
 * a recording.
 *
 *   POST /session-recordings/:id/spec  { from_ms?, to_ms? }
 *     → { data: { name, title, steps, viewport, origin, placeholders, unresolved, … } }
 *
 * Answers the golden-path recorder's steps rather than finished text: the
 * admin loads them into the E2E recorder page, which renders them with its
 * own renderSpec (one renderer, one house style), lets the author edit them,
 * and saves into an extension's tests dir through /dev-tools/e2e-specs —
 * which, as for a live recording, only works on a development machine.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function offset(raw: unknown): number | null | false {
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : false
}

export async function sessionReplaySpecRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.post<{ Params: { id: string }; Body: { from_ms?: unknown; to_ms?: unknown } }>(
    '/:id/spec',
    async (req, reply) => {
      const id = req.params.id
      if (!UUID_RE.test(id)) return reply.code(404).send({ error: 'Not found' })
      const fromMs = offset(req.body?.from_ms)
      const toMs = offset(req.body?.to_ms)
      if (
        fromMs === false ||
        toMs === false ||
        (fromMs != null && toMs != null && toMs <= fromMs)
      ) {
        return reply.code(400).send({
          error: 'from_ms and to_ms must be offsets into the recording, from before to',
          code: 'WINDOW_INVALID'
        })
      }
      const header = await loadRecordingHeader(id)
      if (!header) return reply.code(404).send({ error: 'Not found' })
      const events = await loadRecordingEvents(id)
      if (events.length === 0) return reply.code(404).send({ error: 'No events' })

      const plan = buildSpecPlan(events, fromMs, toMs)
      const short = id.slice(0, 8).toLowerCase()
      const span = `${fmtClock(fromMs ?? 0)}–${toMs != null ? fmtClock(toMs) : 'end'}`
      const who = header.user_name ? `${header.user_name}'s session` : 'a session'
      const day = header.started_at ? new Date(header.started_at).toISOString().slice(0, 10) : ''
      await logActivity({
        action: 'session-recording-spec',
        collection: 'nivaro_session_recordings',
        item: id,
        user: req.user?.id,
        comment: `playwright spec ${span}: ${plan.steps.length} step(s), ${plan.placeholders} placeholder(s), ${plan.unresolved} unresolved`,
        req
      })
      return reply.send({
        data: {
          recording_id: id,
          from_ms: fromMs,
          to_ms: toMs,
          name: `replay-${short}`,
          title: `Replay of ${who}${day ? ` on ${day}` : ''} (${span})`,
          ...plan
        }
      })
    }
  )
}
