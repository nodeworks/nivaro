import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'

function escapeCsv(v: unknown): string {
  if (v == null) return ''
  const s = String(v)
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function toCsv(rows: Record<string, unknown>[], fields: string[]): string {
  const header = fields.map(escapeCsv).join(',')
  const lines = rows.map((r) => fields.map((f) => escapeCsv(r[f])).join(','))
  return [header, ...lines].join('\r\n')
}

export async function contentExportRoutes(app: FastifyInstance) {
  app.post('/:collection', { preHandler: authenticate }, async (req, reply) => {
    const { collection } = req.params as { collection: string }

    if (collection.startsWith('nivaro_')) {
      return reply.code(403).send({ error: 'Cannot export system tables' })
    }

    const body = req.body as {
      format?: 'csv' | 'json' | 'xlsx'
      filters?: Record<string, unknown>
      fields?: string[]
    }

    const format = body.format ?? 'json'
    const filterMap = body.filters ?? {}
    const requestedFields = body.fields

    if (!(await can(req.user!, 'read', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    // Verify collection is registered
    const colMeta = await db('nivaro_collections').where({ collection }).first()
    if (!colMeta) {
      return reply.code(404).send({ error: 'Collection not found' })
    }

    let query = db(collection)

    // Apply simple equality filters
    for (const [key, val] of Object.entries(filterMap)) {
      if (val !== undefined && val !== null) {
        query = query.where(key, val as string | number | boolean)
      }
    }

    if (requestedFields && requestedFields.length > 0) {
      query = query.select(requestedFields)
    }

    const rows = (await query) as Record<string, unknown>[]

    // Determine field list
    let fields: string[]
    if (requestedFields && requestedFields.length > 0) {
      fields = requestedFields
    } else {
      const keySet = new Set<string>()
      for (const r of rows) {
        for (const k of Object.keys(r)) keySet.add(k)
      }
      fields = [...keySet]
    }

    await logActivity({
      action: 'export',
      user: req.user?.id,
      collection,
      comment: `${format} (${rows.length} rows)`,
      req
    })

    if (format === 'csv') {
      const csv = toCsv(rows, fields)
      return reply
        .header('Content-Type', 'text/csv')
        .header('Content-Disposition', `attachment; filename="${collection}-export.csv"`)
        .send(csv)
    }

    if (format === 'xlsx') {
      // XLSX requires exceljs — return JSON with note for now
      return reply
        .header('Content-Type', 'application/json')
        .header('Content-Disposition', `attachment; filename="${collection}-export.json"`)
        .send({ data: rows, _note: 'XLSX export requires exceljs; JSON returned instead' })
    }

    // JSON
    return reply
      .header('Content-Type', 'application/json')
      .header('Content-Disposition', `attachment; filename="${collection}-export.json"`)
      .send({ data: rows })
  })
}
