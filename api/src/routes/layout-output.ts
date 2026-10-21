import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { markConfigRead } from '../services/config-live.js'
import { type FormLayoutStructure, loadFormLayout } from '../services/form-layout.js'
import { ForbiddenError, readItems } from '../services/items.js'
import {
  blankFormHtml,
  buildHelpSheet,
  buildSpreadsheet,
  flattenForm,
  type HelpRow,
  type OutputField,
  parseHelpSheet
} from '../services/layout-output.js'
import { htmlToPdf } from '../services/pdf-layout.js'
import { can, getAllowedFields } from '../services/permissions.js'
import { resolvePathValues } from '../services/queues.js'
import type { User } from '../types.js'

/**
 * Form-shaped outputs under /collection-layouts (#2721 #2724 #2729):
 *
 *  - GET  /:id/spreadsheet-template  an empty Excel import template, columns in the form's order
 *  - POST /:id/spreadsheet-export    {ids?, filter?, search?, limit?} records in the same shape
 *  - GET  /:id/blank-form            the form as a blank printable PDF
 *  - POST /help-sheet/xlsx           (admin) {rows} the labels / help text / placeholders as a workbook
 *  - POST /help-sheet/parse          (admin) {file} the uploaded workbook's rows; the editor diffs them
 *
 * Template / blank form follow what the caller may create; the export reads
 * through the items service, so row filters, field access and scopes bind as
 * for any list.
 */

const EXPORT_CAP = 5000
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const HELP_ROW_CAP = 5000

interface LayoutHead {
  id: number
  collection: string
  name: string
  layout_type: string | null
  pdf_page_size: string | null
  pdf_orientation: string | null
}

const slugName = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'form'

async function loadHead(idParam: string): Promise<LayoutHead | null> {
  if (!/^\d{1,10}$/.test(idParam)) return null
  const row = (await db('nivaro_collection_layouts')
    .where({ id: Number(idParam) })
    .first('id', 'collection', 'name', 'layout_type', 'pdf_page_size', 'pdf_orientation')) as
    | LayoutHead
    | undefined
  return row ?? null
}

async function collectionLabel(collection: string): Promise<string> {
  const meta = (await db('nivaro_collections')
    .where({ collection })
    .first('singular', 'display_name')
    .catch(() => undefined)) as { singular: string | null; display_name: string | null } | undefined
  return (
    meta?.singular ||
    meta?.display_name ||
    collection.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  )
}

/** The form's fields the caller may use: cut to the field list their role grants for `action`. */
async function fieldsFor(
  user: User,
  head: LayoutHead,
  action: 'create' | 'read',
  includeReadonly: boolean
): Promise<{ structure: FormLayoutStructure; fields: OutputField[] } | null> {
  const structure = await loadFormLayout(head.id, head.collection, {
    includeReadonly,
    withOverrides: true
  })
  if (!structure) return null
  const allowed = await getAllowedFields(user, action, head.collection)
  const ok = (f: OutputField) =>
    allowed === null || allowed.includes('*') || allowed.includes(f.path)
  const fields = flattenForm(structure).filter(ok)
  return { structure, fields }
}

export async function registerLayoutOutputRoutes(app: FastifyInstance): Promise<void> {
  app.get('/:id/spreadsheet-template', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const user = req.user as User
    const head = await loadHead(id)
    if (!head) return reply.code(404).send({ error: 'Layout not found' })
    if (!(await can(user, 'create', head.collection)))
      return reply.code(403).send({ error: 'Forbidden' })
    const form = await fieldsFor(user, head, 'create', false)
    if (!form || form.fields.length === 0)
      return reply.code(404).send({ error: 'This form has no fields to put in a spreadsheet' })
    const buf = buildSpreadsheet({
      fields: form.fields,
      formName: head.name,
      collectionLabel: await collectionLabel(head.collection)
    })
    await logActivity({
      action: 'layout-spreadsheet-template',
      user: user.id,
      collection: head.collection,
      comment: `#${head.id}`,
      req
    })
    return reply
      .header('Content-Type', XLSX_TYPE)
      .header(
        'Content-Disposition',
        `attachment; filename="${slugName(`${head.collection}-${head.name}`)}-template.xlsx"`
      )
      .send(buf)
  })

  app.post('/:id/spreadsheet-export', { preHandler: authenticate }, async (req, reply) => {
    // A read under a metadata route: never flush the config caches for it.
    markConfigRead(req)
    const { id } = req.params as { id: string }
    const user = req.user as User
    const head = await loadHead(id)
    if (!head) return reply.code(404).send({ error: 'Layout not found' })
    const body = (req.body ?? {}) as {
      ids?: unknown
      filter?: unknown
      search?: unknown
      limit?: unknown
    }
    const form = await fieldsFor(user, head, 'read', true)
    if (!form || form.fields.length === 0)
      return reply.code(404).send({ error: 'This form has no fields to export' })
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((v) => typeof v === 'string' || typeof v === 'number').slice(0, EXPORT_CAP)
      : null
    const limit = Math.min(EXPORT_CAP, Math.max(1, Number(body.limit) || EXPORT_CAP))
    const filter =
      ids && ids.length > 0
        ? { id: { _in: ids } }
        : body.filter && typeof body.filter === 'object'
          ? (body.filter as Record<string, unknown>)
          : {}
    let rows: Array<Record<string, unknown>>
    try {
      const res = await readItems(
        user,
        head.collection,
        {
          fields: ['id', ...form.fields.map((f) => f.path)],
          filter,
          limit,
          ...(typeof body.search === 'string' && body.search ? { search: body.search } : {})
        },
        undefined,
        req.workspaceId ?? undefined
      )
      rows = res.data as Array<Record<string, unknown>>
    } catch (e) {
      if (e instanceof ForbiddenError) return reply.code(403).send({ error: 'Forbidden' })
      throw e
    }

    // A column that points at another record exports that record's label, not its id.
    if (rows.length > 0) {
      const pointers = (await db('nivaro_relations')
        .where({ many_collection: head.collection })
        .whereNotNull('one_collection')
        .whereNull('junction_field')
        .select('many_field')) as Array<{ many_field: string }>
      const pointerFields = new Set(pointers.map((p) => p.many_field))
      const rowIds = rows.map((r) => String(r.id))
      const cache = new Map()
      await Promise.all(
        form.fields
          .filter((f) => pointerFields.has(f.path))
          .map(async (f) => {
            try {
              const byRow = await resolvePathValues(head.collection, rowIds, [f.path], cache)
              for (const r of rows) {
                const v = byRow.get(String(r.id))?.value
                if (v) r[f.path] = v
              }
            } catch {
              /* the column keeps the stored id */
            }
          })
      )
    }

    const buf = buildSpreadsheet({
      fields: form.fields,
      records: rows,
      withId: true,
      formName: head.name,
      collectionLabel: await collectionLabel(head.collection)
    })
    await logActivity({
      action: 'layout-spreadsheet-export',
      user: user.id,
      collection: head.collection,
      comment: `#${head.id} · ${rows.length} rows`,
      req
    })
    return reply
      .header('Content-Type', XLSX_TYPE)
      .header(
        'Content-Disposition',
        `attachment; filename="${slugName(`${head.collection}-${head.name}`)}.xlsx"`
      )
      .send(buf)
  })

  app.get('/:id/blank-form', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const user = req.user as User
    const head = await loadHead(id)
    if (!head) return reply.code(404).send({ error: 'Layout not found' })
    if (!(await can(user, 'create', head.collection)))
      return reply.code(403).send({ error: 'Forbidden' })
    const form = await fieldsFor(user, head, 'create', false)
    if (!form || form.fields.length === 0)
      return reply.code(404).send({ error: 'This form has no fields to print' })
    const [label, settings] = await Promise.all([
      collectionLabel(head.collection),
      db('nivaro_settings')
        .where({ id: 1 })
        .first('logo_url')
        .catch(() => null) as Promise<{ logo_url: string | null } | null>
    ])
    const html = blankFormHtml({
      structure: form.structure,
      fields: form.fields,
      title: head.name || label,
      subtitle: head.name && head.name !== label ? label : null,
      logoUrl: settings?.logo_url ?? null
    })
    const pdf = await htmlToPdf(html, {
      format: head.pdf_page_size === 'Letter' ? 'Letter' : 'A4',
      landscape: head.pdf_orientation === 'landscape',
      margin: '14mm'
    })
    await logActivity({
      action: 'pdf-generate',
      user: user.id,
      collection: head.collection,
      comment: `blank form #${head.id}`,
      req
    })
    return reply
      .header('Content-Type', 'application/pdf')
      .header(
        'Content-Disposition',
        `attachment; filename="${slugName(`${head.collection}-${head.name}`)}-blank.pdf"`
      )
      .send(pdf)
  })

  // The editor builds the rows from its draft (so unsaved edits are in the
  // file); the server only turns them into a workbook and back.
  app.post('/help-sheet/xlsx', { preHandler: requireAdmin }, async (req, reply) => {
    markConfigRead(req)
    const body = (req.body ?? {}) as { rows?: unknown; name?: unknown }
    if (!Array.isArray(body.rows)) return reply.code(400).send({ error: 'rows required' })
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')
    const rows: HelpRow[] = body.rows.slice(0, HELP_ROW_CAP).map((raw) => {
      const r = (raw ?? {}) as Record<string, unknown>
      return {
        key: str(r.key, 200),
        kind: r.kind === 'section' ? 'section' : 'field',
        section: str(r.section, 200),
        field: str(r.field, 200),
        label: str(r.label, 500),
        help: str(r.help, 2000),
        placeholder: str(r.placeholder, 500)
      }
    })
    const buf = buildHelpSheet(rows)
    return reply
      .header('Content-Type', XLSX_TYPE)
      .header(
        'Content-Disposition',
        `attachment; filename="${slugName(typeof body.name === 'string' ? body.name : 'form')}-help-text.xlsx"`
      )
      .send(buf)
  })

  app.post(
    '/help-sheet/parse',
    { preHandler: requireAdmin, bodyLimit: 8 * 1024 * 1024 },
    async (req, reply) => {
      markConfigRead(req)
      const body = (req.body ?? {}) as { file?: unknown }
      if (typeof body.file !== 'string' || body.file.length === 0)
        return reply.code(400).send({ error: 'file required (base64)' })
      const rows = parseHelpSheet(Buffer.from(body.file, 'base64'))
      if (!rows)
        return reply.code(400).send({
          error: 'That file is not a help text sheet. Download one from the editor and edit it.'
        })
      return reply.send({ data: { rows } })
    }
  )
}
