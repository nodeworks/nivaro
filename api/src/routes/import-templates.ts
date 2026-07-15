import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { selectInChunks } from '../services/db-batch.js'
import { uploadFileBuffer } from '../services/files.js'
import { readSpreadsheet } from '../services/import-spreadsheet.js'
import type { LookupFetcher } from '../services/import-templates.js'
import { runImportPipeline } from '../services/import-templates.js'
import type {
  ConfigError,
  ImportHeaderRule,
  ImportLineConfig,
  ImportTemplateConfig
} from '../services/import-templates-config.js'
import { normalizeImportTemplateConfig } from '../services/import-templates-config.js'
import { applyFieldRules } from '../services/items.js'
import { can } from '../services/permissions.js'

const MAX_FILE_BYTES = 25 * 1024 * 1024

function parseJsonSafe(val: unknown): unknown {
  if (typeof val !== 'string') return val
  try {
    return JSON.parse(val)
  } catch {
    return val
  }
}

function formatTemplate(row: Record<string, unknown>) {
  return {
    ...row,
    file_types: parseJsonSafe(row.file_types) ?? ['xlsx', 'csv'],
    header_map: parseJsonSafe(row.header_map) ?? [],
    line_map: parseJsonSafe(row.line_map),
    is_active: !!row.is_active,
    is_shared: !!row.is_shared
  }
}

/** Reconstructs the ImportTemplateConfig shape from a saved template row's JSON columns. */
function templateRowToConfig(row: Record<string, unknown>): ImportTemplateConfig {
  return {
    file_types: (parseJsonSafe(row.file_types) as ('xlsx' | 'csv')[] | null) ?? ['xlsx', 'csv'],
    sheet_match: (row.sheet_match as string | null) ?? null,
    header_row: Number(row.header_row) || 1,
    header_map: (parseJsonSafe(row.header_map) as ImportHeaderRule[] | null) ?? [],
    line_map: parseJsonSafe(row.line_map) as ImportLineConfig | null,
    attach_file_field: (row.attach_file_field as string | null) ?? null
  }
}

/** Case-insensitive matching happens in the pipeline map, not here — MSSQL's default
 *  collation is already case-insensitive, but the pipeline normalizes anyway. */
function makeLookupFetcher(): LookupFetcher {
  return async ({ collection, match_field, values, scope_filters }) => {
    if (/^nivaro_/i.test(collection)) return []
    return selectInChunks(values, 500, (chunk) => {
      let q = db(collection).select('*').whereIn(match_field, chunk)
      for (const f of scope_filters) {
        q =
          f.op === 'neq'
            ? q.whereNot(f.field, f.value as never)
            : q.where(f.field, f.value as never)
      }
      return q
    })
  }
}

/** Resolves the O2M child collection for a line_map target_field: the relation row
 *  where `one_collection = collection AND one_field = target_field`. */
async function resolveLineChildCollection(
  collection: string,
  targetField: string
): Promise<string | null> {
  const relation = (await db('nivaro_relations')
    .where({ one_collection: collection, one_field: targetField })
    .first()) as { many_collection: string } | undefined
  return relation?.many_collection ?? null
}

/** Validates a normalized config's field/collection targets against live schema
 *  metadata, appending ConfigError entries in place. Only called when the config
 *  normalized cleanly — no point validating targets on an already-invalid shape. */
async function validateConfigAgainstSchema(
  config: ImportTemplateConfig,
  collection: string,
  errors: ConfigError[]
): Promise<void> {
  const collRow = await db('nivaro_collections').where({ collection }).first()
  if (!collRow) {
    errors.push({ path: 'collection', message: `Unknown collection "${collection}"` })
    return
  }

  const fieldRows = (await db('nivaro_fields').where({ collection }).select('field')) as {
    field: string
  }[]
  const fieldSet = new Set(fieldRows.map((r) => r.field))
  config.header_map.forEach((rule, i) => {
    if (!fieldSet.has(rule.target)) {
      errors.push({
        path: `header_map[${i}].target`,
        message: `Unknown field "${rule.target}" on ${collection}`
      })
    }
  })

  if (config.line_map) {
    const childCollection = await resolveLineChildCollection(
      collection,
      config.line_map.target_field
    )
    if (!childCollection) {
      errors.push({
        path: 'line_map.target_field',
        message: `No one-to-many relation found for "${config.line_map.target_field}" on ${collection}`
      })
      return
    }
    const childFieldRows = (await db('nivaro_fields')
      .where({ collection: childCollection })
      .select('field')) as { field: string }[]
    const childFieldSet = new Set(childFieldRows.map((r) => r.field))
    config.line_map.columns.forEach((col, i) => {
      if (!childFieldSet.has(col.target)) {
        errors.push({
          path: `line_map.columns[${i}].target`,
          message: `Unknown field "${col.target}" on ${childCollection}`
        })
      }
    })
  }
}

export async function importTemplatesRoutes(app: FastifyInstance) {
  // GET /import-templates?collection=&mode= — visibility: created_by=me OR
  // (is_shared=1 AND (role_id IS NULL OR role_id=myRole)); only is_active=1 unless admin.
  app.get('/', { preHandler: authenticate }, async (req, reply) => {
    const { collection, mode } = req.query as { collection?: string; mode?: string }
    const userId = req.user!.id
    const userRole = req.user!.role
    const isAdmin = req.isAdmin ?? false

    const query = db('nivaro_import_templates').orderBy('created_at', 'desc')

    if (!isAdmin) {
      query.where(function () {
        this.where({ created_by: userId }).orWhere(function () {
          this.where({ is_shared: true }).andWhere(function () {
            this.whereNull('role_id')
            if (userRole) this.orWhere({ role_id: userRole })
          })
        })
      })
      query.andWhere({ is_active: true })
    }

    if (collection) query.andWhere({ collection })
    if (mode) query.andWhere({ mode })

    const rows = (await query) as Record<string, unknown>[]
    return reply.send({ data: rows.map(formatTemplate) })
  })

  // POST /import-templates — create
  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name : ''
    const collection = typeof body.collection === 'string' ? body.collection : ''
    if (!name || !collection) {
      return reply.code(400).send({ error: 'name and collection are required' })
    }

    const { config, errors } = normalizeImportTemplateConfig(body)
    if (errors.length === 0) {
      await validateConfigAgainstSchema(config, collection, errors)
    }
    if (errors.length > 0) {
      return reply.code(400).send({ error: 'Invalid template config', details: errors })
    }

    const id = randomUUID()
    const now = new Date()
    await db('nivaro_import_templates').insert({
      id,
      name,
      collection,
      mode: typeof body.mode === 'string' ? body.mode : 'prefill',
      file_types: JSON.stringify(config.file_types),
      sheet_match: config.sheet_match,
      header_row: config.header_row,
      header_map: JSON.stringify(config.header_map),
      line_map: config.line_map ? JSON.stringify(config.line_map) : null,
      attach_file_field: config.attach_file_field,
      is_active: body.is_active !== false,
      is_shared: !!body.is_shared,
      role_id: typeof body.role_id === 'string' ? body.role_id : null,
      created_by: req.user!.id,
      created_at: now,
      updated_at: now
    })

    const created = (await db('nivaro_import_templates').where({ id }).first()) as Record<
      string,
      unknown
    >

    await logActivity({
      action: 'import-template-create',
      user: req.user?.id,
      collection: 'nivaro_import_templates',
      item: id,
      req
    })

    return reply.code(201).send({ data: formatTemplate(created) })
  })

  // PATCH /import-templates/:id — update
  app.patch('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = (await db('nivaro_import_templates').where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const body = req.body as Record<string, unknown>
    const collection =
      typeof body.collection === 'string' ? body.collection : (existing.collection as string)

    const rawConfig = {
      file_types: body.file_types ?? parseJsonSafe(existing.file_types),
      sheet_match: 'sheet_match' in body ? body.sheet_match : existing.sheet_match,
      header_row: body.header_row ?? existing.header_row,
      header_map: body.header_map ?? parseJsonSafe(existing.header_map),
      line_map: 'line_map' in body ? body.line_map : parseJsonSafe(existing.line_map),
      attach_file_field:
        'attach_file_field' in body ? body.attach_file_field : existing.attach_file_field
    }

    const { config, errors } = normalizeImportTemplateConfig(rawConfig)
    if (errors.length === 0) {
      await validateConfigAgainstSchema(config, collection, errors)
    }
    if (errors.length > 0) {
      return reply.code(400).send({ error: 'Invalid template config', details: errors })
    }

    const patch: Record<string, unknown> = {
      updated_at: new Date(),
      file_types: JSON.stringify(config.file_types),
      sheet_match: config.sheet_match,
      header_row: config.header_row,
      header_map: JSON.stringify(config.header_map),
      line_map: config.line_map ? JSON.stringify(config.line_map) : null,
      attach_file_field: config.attach_file_field
    }
    if (typeof body.name === 'string') patch.name = body.name
    if (typeof body.collection === 'string') patch.collection = body.collection
    if (typeof body.mode === 'string') patch.mode = body.mode
    if (typeof body.is_active === 'boolean') patch.is_active = body.is_active
    if (typeof body.is_shared === 'boolean') patch.is_shared = body.is_shared
    if ('role_id' in body) patch.role_id = typeof body.role_id === 'string' ? body.role_id : null

    await db('nivaro_import_templates').where({ id }).update(patch)
    const updated = (await db('nivaro_import_templates').where({ id }).first()) as Record<
      string,
      unknown
    >

    await logActivity({
      action: 'import-template-update',
      user: req.user?.id,
      collection: 'nivaro_import_templates',
      item: id,
      req
    })

    return reply.send({ data: formatTemplate(updated) })
  })

  // DELETE /import-templates/:id
  app.delete('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = (await db('nivaro_import_templates').where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    await db('nivaro_import_templates').where({ id }).delete()

    await logActivity({
      action: 'import-template-delete',
      user: req.user?.id,
      collection: 'nivaro_import_templates',
      item: id,
      req
    })

    return reply.code(204).send()
  })

  // POST /import-templates/:id/parse — run a saved template against an uploaded file
  app.post('/:id/parse', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const template = (await db('nivaro_import_templates').where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!template) return reply.code(404).send({ error: 'Not found' })

    const collection = template.collection as string
    if (!(await can(req.user!, 'create', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const multipart = await req.file()
    if (!multipart) return reply.code(400).send({ error: 'No file provided' })
    const buffer = await multipart.toBuffer()
    if (buffer.length > MAX_FILE_BYTES) {
      return reply.code(413).send({ error: 'File exceeds 25MB limit' })
    }

    const config = templateRowToConfig(template)
    const { rows, issues: sheetIssues } = readSpreadsheet(buffer, multipart.filename, config)
    const structuralErrors = sheetIssues.filter((i) => i.severity === 'error')
    if (structuralErrors.length > 0 && rows.length === 0) {
      return reply.code(422).send({ error: 'File could not be parsed', issues: sheetIssues })
    }

    let applyLineFieldRules: ((draft: Record<string, unknown>) => Promise<void>) | undefined
    if (config.line_map) {
      const childCollection = await resolveLineChildCollection(
        collection,
        config.line_map.target_field
      )
      if (childCollection) {
        applyLineFieldRules = (draft) => applyFieldRules(childCollection, draft)
      }
    }

    const result = await runImportPipeline({
      config,
      rows,
      lookup: makeLookupFetcher(),
      applyLineFieldRules
    })
    const issues = [...sheetIssues, ...result.issues]

    let file_id: string | null = null
    if (config.attach_file_field) {
      const stored = await uploadFileBuffer(
        req.user!,
        buffer,
        multipart.filename,
        multipart.mimetype || 'application/octet-stream'
      )
      file_id = stored.id
    }

    return reply.send({ data: { values: result.values, lines: result.lines, issues, file_id } })
  })

  // POST /import-templates/:id/execute — Task 7
  app.post('/:id/execute', { preHandler: authenticate }, async (_req, reply) => {
    return reply.code(501).send({ error: 'Not implemented' })
  })

  // POST /import-templates/test — builder "test panel": run an unsaved config, no persist
  app.post('/test', { preHandler: requireAdmin }, async (req, reply) => {
    const multipart = await req.file()
    if (!multipart) return reply.code(400).send({ error: 'No file provided' })
    const buffer = await multipart.toBuffer()
    if (buffer.length > MAX_FILE_BYTES) {
      return reply.code(413).send({ error: 'File exceeds 25MB limit' })
    }

    const configField = multipart.fields.config
    const configPart = Array.isArray(configField) ? configField[0] : configField
    if (configPart?.type !== 'field') {
      return reply.code(400).send({ error: 'config field is required' })
    }

    let raw: unknown
    try {
      raw = JSON.parse(String(configPart.value))
    } catch {
      return reply.code(400).send({ error: 'config must be valid JSON' })
    }

    const { config, errors } = normalizeImportTemplateConfig(raw)
    if (errors.length > 0) {
      return reply.code(400).send({ error: 'Invalid template config', details: errors })
    }

    const { rows, issues: sheetIssues } = readSpreadsheet(buffer, multipart.filename, config)
    const structuralErrors = sheetIssues.filter((i) => i.severity === 'error')
    if (structuralErrors.length > 0 && rows.length === 0) {
      return reply.code(422).send({ error: 'File could not be parsed', issues: sheetIssues })
    }

    let applyLineFieldRules: ((draft: Record<string, unknown>) => Promise<void>) | undefined
    const collection = (raw as { collection?: unknown })?.collection
    if (config.line_map && typeof collection === 'string') {
      const childCollection = await resolveLineChildCollection(
        collection,
        config.line_map.target_field
      )
      if (childCollection) {
        applyLineFieldRules = (draft) => applyFieldRules(childCollection, draft)
      }
    }

    const result = await runImportPipeline({
      config,
      rows,
      lookup: makeLookupFetcher(),
      applyLineFieldRules
    })
    const issues = [...sheetIssues, ...result.issues]

    return reply.send({
      data: { values: result.values, lines: result.lines, issues, file_id: null }
    })
  })
}
