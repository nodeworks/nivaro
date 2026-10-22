import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { cutReplayWindow, loadRecordingEvents } from '../services/session-replay-events.js'
import {
  buildExportHtml,
  EXPORT_FORMATS,
  type ExportFormat,
  enqueueWebmExport,
  exportCaption,
  exportFileName,
  fmtClock,
  loadRecordingHeader,
  WEBM_MAX_MS
} from '../services/session-replay-export.js'

/**
 * Export a recording (#1375). Admin-only, like every read of a recording.
 *
 *   POST /session-recordings/:id/export  { format: 'html' | 'webm', from_ms?, to_ms? }
 *     html → 200, the self-contained replay page as an attachment
 *     webm → 202, a background job; the requester is notified with the file
 *
 * from_ms / to_ms are offsets into the recording (the player's clock). Both
 * are activity-logged; events go out exactly as stored, so masked stays masked.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function offset(raw: unknown): number | null | false {
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : false
}

export async function sessionReplayExportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.post<{
    Params: { id: string }
    Body: { format?: unknown; from_ms?: unknown; to_ms?: unknown }
  }>('/:id/export', async (req, reply) => {
    const id = req.params.id
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: 'Not found' })
    const format = String(req.body?.format ?? '') as ExportFormat
    if (!EXPORT_FORMATS.includes(format)) {
      return reply.code(400).send({ error: 'format must be html or webm', code: 'FORMAT_INVALID' })
    }
    const fromMs = offset(req.body?.from_ms)
    const toMs = offset(req.body?.to_ms)
    if (fromMs === false || toMs === false || (fromMs != null && toMs != null && toMs <= fromMs)) {
      return reply.code(400).send({
        error: 'from_ms and to_ms must be offsets into the recording, from before to',
        code: 'WINDOW_INVALID'
      })
    }
    if (format === 'webm' && fromMs != null && toMs != null && toMs - fromMs > WEBM_MAX_MS) {
      return reply.code(400).send({
        error: `A WebM is captured in real time and is capped at ${WEBM_MAX_MS / 60_000} minutes — pick a shorter window`,
        code: 'WINDOW_TOO_LONG'
      })
    }
    const header = await loadRecordingHeader(id)
    if (!header) return reply.code(404).send({ error: 'Not found' })

    if (format === 'webm') {
      // Here, or on the media worker (slim image); neither = a readable 503.
      try {
        await enqueueWebmExport({ recordingId: id, fromMs, toMs, userId: String(req.user?.id) })
      } catch (err) {
        const e = err as { statusCode?: number; code?: string; message?: string }
        if (!e.statusCode) throw err
        return reply.code(e.statusCode).send({ error: e.message, code: e.code })
      }
      await logActivity({
        action: 'session-recording-export',
        collection: 'nivaro_session_recordings',
        item: id,
        user: req.user?.id,
        comment: `webm queued${fromMs != null || toMs != null ? `: ${fmtClock(fromMs ?? 0)}–${toMs != null ? fmtClock(toMs) : 'end'}` : ''}`,
        req
      })
      return reply.code(202).send({ data: { format, status: 'queued' } })
    }

    const win = cutReplayWindow(await loadRecordingEvents(id), fromMs, toMs)
    if (!win) {
      return reply.code(422).send({
        error: 'This recording has no full snapshot to replay from',
        code: 'NOTHING_TO_REPLAY'
      })
    }
    const html = buildExportHtml({
      title: `Replay ${id.slice(0, 8).toLowerCase()}${header.user_name ? ` · ${header.user_name}` : ''}`,
      caption: exportCaption(header, win),
      events: win.events,
      startOffsetMs: win.startOffsetMs,
      endOffsetMs: win.endOffsetMs
    })
    await logActivity({
      action: 'session-recording-export',
      collection: 'nivaro_session_recordings',
      item: id,
      user: req.user?.id,
      comment: `html: ${win.events.length} event(s), ${fmtClock(win.fromMs)}–${fmtClock(win.toMs)}`,
      req
    })
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-disposition', `attachment; filename="${exportFileName(id, 'html')}"`)
      .send(html)
  })
}
