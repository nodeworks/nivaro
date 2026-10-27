import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { isFilesCollection } from '../services/help-video-files.js'
import {
  CollectionNotFoundError,
  ForbiddenError,
  getActualColumns,
  LIST_READ_MAX,
  readItems
} from '../services/items.js'
import { can } from '../services/permissions.js'
import type { ItemsQuery } from '../types.js'

/** Most rows one export holds (same cap as GET /items/:collection/export). */
const EXPORT_MAX_ROWS = 10_000

/** Every matching row the caller may read, page by page through readItems. */
export async function readAllAsCaller(
  req: FastifyRequest,
  collection: string,
  base: Pick<ItemsQuery, 'fields' | 'filter'>
): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
  const hasId = [...(await getActualColumns(collection))].some((c) => c.toLowerCase() === 'id')
  const query: ItemsQuery = {
    ...base,
    sort: hasId ? ['id'] : [],
    limit: LIST_READ_MAX,
    count: false
  }
  const ws = req.workspaceId ?? undefined
  const rows: Record<string, unknown>[] = []
  for (let offset = 0; ; offset += LIST_READ_MAX) {
    if (rows.length >= EXPORT_MAX_ROWS) {
      const more = await readItems(
        req.user!,
        collection,
        { ...query, fields: ['id'], limit: 1, offset: EXPORT_MAX_ROWS },
        req,
        ws
      )
      return { rows, truncated: more.data.length > 0 }
    }
    const page = await readItems(req.user!, collection, { ...query, offset }, req, ws)
    const data = page.data as Record<string, unknown>[]
    rows.push(...data)
    if (data.length < LIST_READ_MAX) return { rows, truncated: false }
  }
}

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

    if (/^nivaro_/i.test(collection) || isFilesCollection(collection)) {
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

    // Rows come from the items service AS THE CALLER (H16): field policy,
    // row filter, User Scopes, workspace scope and system-column rules all
    // apply — never a raw table read. Equality filters become `_eq` filters,
    // so a filter on a field the caller may not read is refused there too.
    const filter: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(filterMap)) {
      if (val !== undefined && val !== null) filter[key] = { _eq: val }
    }
    const fieldList =
      requestedFields && requestedFields.length > 0 ? requestedFields.map(String) : ['*']
    let rows: Record<string, unknown>[]
    let truncated = false
    try {
      const out = await readAllAsCaller(req, collection, { fields: fieldList, filter })
      rows = out.rows
      truncated = out.truncated
    } catch (err) {
      if (err instanceof ForbiddenError) return reply.code(403).send({ error: 'Forbidden' })
      if (err instanceof CollectionNotFoundError) {
        return reply.code(404).send({ error: 'Collection not found' })
      }
      throw err
    }
    if (truncated) reply.header('x-nivaro-export-truncated', String(EXPORT_MAX_ROWS))

    // Determine field list
    let fields: string[]
    if (requestedFields && requestedFields.length > 0) {
      // Only columns the caller's read actually returned (a field the policy
      // hides is never echoed back as an empty column).
      const seen = new Set<string>()
      for (const r of rows) for (const k of Object.keys(r)) seen.add(k)
      fields = requestedFields.map(String).filter((f) => f !== '*' && seen.has(f))
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
