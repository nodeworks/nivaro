import type { FastifyInstance } from 'fastify'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import {
  downloadReport,
  downloadReportCsv,
  recordDownloadStats
} from '../services/file-downloads.js'

/**
 * File downloads (#3234 log, #3235 report). The log is written by GET /api/files/:id
 * (services/file-downloads.ts); these routes only read it.
 *
 *   GET /api/file-downloads/on-record?collection=&item=&ids=a,b   (admin; the record must be readable)
 *   GET /api/file-downloads/report?from=&to=&collection=&user=&format=csv   (admin)
 */
/** A range bound: an ISO instant (the client sends its own local midnight), or a bare
 *  YYYY-MM-DD read as that UTC day (`endOfDay` = the start of the next one). */
function bound(v: unknown, endOfDay = false): Date | null {
  if (typeof v !== 'string' || !v) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(`${v}T00:00:00.000Z`)
    if (Number.isNaN(d.getTime())) return null
    if (endOfDay) d.setUTCDate(d.getUTCDate() + 1)
    return d
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v)) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

export async function fileDownloadsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // Administrators only, like the report: who downloaded a file is not for every reader.
  app.get('/on-record', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as { collection?: string; item?: string; ids?: string }
    const collection = String(q.collection ?? '').trim()
    const item = String(q.item ?? '').trim()
    if (!collection || !item)
      return reply.code(400).send({ error: 'collection and item are required' })
    const ids = String(q.ids ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    return reply.send({ data: await recordDownloadStats(req, collection, item, ids) })
  })

  app.get('/report', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as {
      from?: string
      to?: string
      collection?: string
      user?: string
      format?: string
    }
    // Default: the last 30 days.
    const to = bound(q.to, true)
    const from = bound(q.from) ?? new Date((to ?? new Date()).getTime() - 30 * 86_400_000)
    const report = await downloadReport(req, {
      from,
      to,
      collection: q.collection?.trim() || null,
      user: q.user?.trim() || null
    })
    if (q.format === 'csv') {
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="file-downloads.csv"')
        .send(downloadReportCsv(report))
    }
    return reply.send({
      data: { ...report, from: from.toISOString(), to: to?.toISOString() ?? null }
    })
  })
}
