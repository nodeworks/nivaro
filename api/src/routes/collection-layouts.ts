import { randomUUID } from 'crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { ForbiddenError, ItemNotFoundError, readOne } from '../services/items.js'
import { generatePdfFromLayout } from '../services/pdf-layout.js'
import { classicTheme, executiveTheme, minimalTheme } from '../services/pdf-layout-themes.js'
import { can } from '../services/permissions.js'
import { getStorage, getStorageProviderName } from '../services/storage/index.js'

type LayoutConditions = { role_ids?: string[] } | null

export type RecordConditionRule = { field: string; op: 'eq' | 'neq' | 'nnull'; value?: unknown }

// Safely parse the conditions JSON text column into an object (or null).
function parseConditions(raw: unknown): LayoutConditions {
  if (raw == null) return null
  if (typeof raw === 'object') return raw as LayoutConditions
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as LayoutConditions) : null
  } catch {
    return null
  }
}

// Safely parse the record_conditions JSON text column into a rule array (or null).
function parseRecordConditions(raw: unknown): RecordConditionRule[] | null {
  if (raw == null) return null
  if (Array.isArray(raw)) return raw as RecordConditionRule[]
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as RecordConditionRule[]) : null
  } catch {
    return null
  }
}

// Safely parse the default_values JSON text column into a plain object (or null).
function parseDefaultValues(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// Does every rule match the given record? eq/neq compare via
// String(raw ?? '') === String(value) (tolerant of numeric/string mismatches,
// e.g. workflow_type stored as 2 vs '2'); nnull checks raw != null.
export function matchesRecordConditions(rules: RecordConditionRule[], record: Record<string, unknown>): boolean {
  return rules.every((rule) => {
    const raw = record[rule.field]
    if (rule.op === 'nnull') return raw != null
    if (rule.op === 'eq') return String(raw ?? '') === String(rule.value)
    return String(raw ?? '') !== String(rule.value)
  })
}

const FIELD_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

// Validate a PATCH body's record_conditions array; returns an error string
// (naming the offending index) or null when valid.
function validateRecordConditions(rules: unknown): string | null {
  if (!Array.isArray(rules)) return 'record_conditions must be an array'
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i] as Record<string, unknown> | null
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      return `record_conditions[${i}] must be an object`
    }
    if (typeof rule.field !== 'string' || !FIELD_IDENTIFIER_RE.test(rule.field)) {
      return `record_conditions[${i}].field must be a valid field identifier`
    }
    if (rule.op !== 'eq' && rule.op !== 'neq' && rule.op !== 'nnull') {
      return `record_conditions[${i}].op must be one of eq, neq, nnull`
    }
    if ((rule.op === 'eq' || rule.op === 'neq') && rule.value === undefined) {
      return `record_conditions[${i}].value is required for op ${rule.op}`
    }
  }
  return null
}

// Validate a PATCH body's default_values object; returns an error string
// (naming the offending key) or null when valid.
function validateDefaultValues(values: unknown): string | null {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return 'default_values must be an object'
  }
  for (const key of Object.keys(values as Record<string, unknown>)) {
    if (!FIELD_IDENTIFIER_RE.test(key)) return `default_values.${key} is not a valid field identifier`
  }
  return null
}

// Resolve the best-matching layout for a collection given the user's role and
// (optionally) the record being edited. Precedence: record-condition layouts
// (ALL rules match; most rules wins; ties by is_active desc, sort asc) > role
// -condition layouts (conditions.role_ids includes userRoleId; most role_ids
// wins) > default (is_active=1) > first by sort. A layout carrying
// record_conditions is excluded from the role/default fallback pool entirely
// when it does not match (or no record is supplied) — it can never leak to
// non-matching records. Returns the raw DB row (JSON columns still strings)
// or null when no layout exists.
async function resolveLayout(
  collection: string,
  userRoleId: string | null | undefined,
  record: Record<string, unknown> | null
) {
  const layouts = await db('nivaro_collection_layouts')
    .where({ collection })
    .orderByRaw('is_active desc, sort asc')

  if (layouts.length === 0) return null

  const fallbackPool: typeof layouts = []
  let bestRecordMatch: { row: (typeof layouts)[number]; matches: number } | null = null
  for (const row of layouts) {
    const rules = parseRecordConditions(row.record_conditions)
    if (rules) {
      if (record && matchesRecordConditions(rules, record)) {
        const matches = rules.length
        if (!bestRecordMatch || matches > bestRecordMatch.matches) bestRecordMatch = { row, matches }
      }
      continue // excluded from the role/default fallback pool regardless of match
    }
    fallbackPool.push(row)
  }
  if (bestRecordMatch) return bestRecordMatch.row

  if (userRoleId) {
    let best: { row: (typeof layouts)[number]; matches: number } | null = null
    for (const row of fallbackPool) {
      const cond = parseConditions(row.conditions)
      const roleIds = cond?.role_ids
      if (Array.isArray(roleIds) && roleIds.includes(userRoleId)) {
        const matches = roleIds.length
        if (!best || matches > best.matches) best = { row, matches }
      }
    }
    if (best) return best.row
  }

  // Fall back to the active (default) layout, else the first by sort.
  return fallbackPool.find((l) => l.is_active) ?? fallbackPool[0] ?? null
}

export async function collectionLayoutsRoutes(app: FastifyInstance) {
  // GET /collection-layouts/active?collection=x — MUST be before /:id
  app.get('/active', { preHandler: authenticate }, async (req, reply) => {
    const { collection, slug, item } = req.query as { collection?: string; slug?: string; item?: string }
    if (!collection) return reply.code(400).send({ error: 'collection is required' })

    // Explicit slug pins a specific layout (any type — detail layouts use this
    // for drill-down rendering), bypassing role- and record-conditional resolution.
    let layout: Record<string, unknown> | undefined | null
    if (slug) {
      layout = await db('nivaro_collection_layouts').where({ collection, slug }).first()
    }
    if (!layout) {
      // Admins always see the default layout (no conditional override).
      const userRoleId = req.isAdmin ? null : (req.user?.role ?? null)
      // An unknown/missing item id resolves to no record — falls through to
      // the role/default path exactly like the no-item case.
      const record = item
        ? ((await db(collection).where({ id: item }).first().catch(() => null)) ?? null)
        : null
      layout = await resolveLayout(collection, userRoleId, record)
    }
    if (!layout) return reply.code(404).send({ error: 'No layout found' })

    layout.conditions = parseConditions(layout.conditions)
    layout.record_conditions = parseRecordConditions(layout.record_conditions)
    layout.default_values = parseDefaultValues(layout.default_values)

    const [groups, assignments] = await Promise.all([
      db('nivaro_field_groups').where({ layout_id: layout.id }).orderBy('sort', 'asc'),
      db('nivaro_layout_field_assignments')
        .where({ layout_id: layout.id })
        .select('field', 'group_key', 'sort', 'label_override', 'is_visible', 'default_expanded', 'lock_conditions', 'overrides', 'show_row_revisions', 'show_approval_chain', 'widget_id', 'input_bindings', 'allow_revision_restore')
        .orderBy('sort', 'asc')
    ])

    const ungroupedRow = assignments.find((a: { field: string; sort: number }) => a.field === '__ungrouped_pos__')
    const ungrouped_sort: number | null = ungroupedRow ? ungroupedRow.sort : null

    return reply.send({ data: { layout, groups, assignments, ungrouped_sort } })
  })

  // GET /collection-layouts/detail/:collection?layout_id= — resolve the detail
  // layout a drill-down sheet should render: explicit layout_id (must be a
  // detail layout of this collection) → active detail layout → null (caller
  // falls back to auto read-only rendering).
  app.get('/detail/:collection', { preHandler: authenticate }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const { layout_id } = req.query as { layout_id?: string }

    let layout: Record<string, unknown> | undefined
    if (layout_id) {
      layout = await db('nivaro_collection_layouts')
        .where({ id: Number(layout_id), collection, layout_type: 'detail' })
        .first()
    }
    if (!layout) {
      layout = await db('nivaro_collection_layouts')
        .where({ collection, layout_type: 'detail' })
        .orderByRaw('is_active desc, sort asc')
        .first()
    }
    if (!layout) return reply.send({ data: null })

    const [groups, assignments] = await Promise.all([
      db('nivaro_field_groups').where({ layout_id: layout.id }).orderBy('sort', 'asc'),
      db('nivaro_layout_field_assignments')
        .where({ layout_id: layout.id })
        .select('field', 'group_key', 'sort', 'label_override', 'is_visible', 'default_expanded', 'overrides')
        .orderBy('sort', 'asc')
    ])
    return reply.send({ data: { layout, groups, assignments } })
  })

  // GET /collection-layouts?collection=x[&active=true]
  app.get('/', { preHandler: authenticate }, async (req, reply) => {
    const { collection, active } = req.query as { collection?: string; active?: string }
    if (!collection) return reply.code(400).send({ error: 'collection is required' })

    let q = db('nivaro_collection_layouts')
      .where({ collection })
      .orderBy('sort', 'asc')
      .select(
        'id', 'collection', 'name', 'slug', 'is_active', 'sort', 'created_at',
        'disable_comments', 'disable_tasks', 'disable_revisions', 'disable_clone', 'disable_delete',
        'accordion_mode', 'tab_mode', 'validate_before_next', 'summary_enabled', 'summary_show_all',
        'summary_hide_empty', 'ai_enabled', 'conditions', 'allow_clone', 'allow_schedule',
        'allow_disable_pickers', 'layout_type', 'row_order_field',
        'pdf_theme', 'pdf_template_id', 'pdf_cover_enabled', 'pdf_cover_title_field',
        'pdf_cover_subtitle', 'pdf_show_logo', 'pdf_page_size', 'pdf_orientation', 'pdf_button_label',
        'addendum_layout_id', 'workflow_template_id', 'single_active_addendum', 'addendum_default_view',
        'record_conditions', 'default_values'
      )
    if (active === 'true') q = q.where({ is_active: 1 })

    const rows = await q
    for (const row of rows) {
      row.conditions = parseConditions(row.conditions)
      row.record_conditions = parseRecordConditions(row.record_conditions)
      row.default_values = parseDefaultValues(row.default_values)
    }
    return reply.send({ data: rows })
  })

  // POST /collection-layouts
  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as { collection: string; name: string }
    if (!body.collection || !body.name) return reply.code(400).send({ error: 'collection and name are required' })

    const maxSortRow = await db('nivaro_collection_layouts')
      .where({ collection: body.collection })
      .max('sort as m')
      .first()
    const maxSort = (maxSortRow?.m as number | null) ?? -1

    try {
      await db('nivaro_collection_layouts')
        .insert({ collection: body.collection, name: body.name, is_active: 0, sort: maxSort + 1 })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : ''
      if (msg.toLowerCase().includes('unique') || msg.toLowerCase().includes('duplicate')) {
        return reply.code(409).send({ error: 'A layout with that name already exists' })
      }
      throw err
    }
    const created = await db('nivaro_collection_layouts')
      .where({ collection: body.collection, name: body.name })
      .orderBy('id', 'desc')
      .first()

    await logActivity({ action: 'create', user: req.user?.id, collection: 'nivaro_collection_layouts', item: String(created.id), req })
    return reply.code(201).send({ data: created })
  })

  // GET /collection-layouts/:id
  app.get('/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = await db('nivaro_collection_layouts').where({ id }).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    row.conditions = parseConditions(row.conditions)
    row.record_conditions = parseRecordConditions(row.record_conditions)
    row.default_values = parseDefaultValues(row.default_values)
    return reply.send({ data: row })
  })

  // PATCH /collection-layouts/:id
  app.patch('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await db('nivaro_collection_layouts').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const body = req.body as Partial<{ name: string; slug: string | null; sort: number; is_active: boolean; disable_comments: boolean; disable_tasks: boolean; tab_mode: string; validate_before_next: boolean; summary_enabled: boolean; summary_show_all: boolean; ai_enabled: boolean; conditions: { role_ids?: string[] } | null; allow_clone: boolean; allow_schedule: boolean; allow_disable_pickers: boolean; layout_type: string; addendum_layout_id: number | null; workflow_template_id: string | null; single_active_addendum: boolean; addendum_default_view: boolean; record_conditions: RecordConditionRule[] | null; default_values: Record<string, unknown> | null }>

    if (body.record_conditions !== undefined && body.record_conditions !== null) {
      const err = validateRecordConditions(body.record_conditions)
      if (err) return reply.code(400).send({ error: err })
    }
    if (body.default_values !== undefined && body.default_values !== null) {
      const err = validateDefaultValues(body.default_values)
      if (err) return reply.code(400).send({ error: err })
    }

    const patch: Record<string, unknown> = {}
    if (body.name !== undefined) patch.name = body.name
    if (body.slug !== undefined) patch.slug = body.slug ?? null
    if (body.sort !== undefined) patch.sort = body.sort
    if (body.is_active !== undefined) patch.is_active = body.is_active ? 1 : 0
    if (body.disable_comments !== undefined) patch.disable_comments = body.disable_comments ? 1 : 0
    if (body.disable_tasks !== undefined) patch.disable_tasks = body.disable_tasks ? 1 : 0
    if (body.tab_mode !== undefined) patch.tab_mode = body.tab_mode
    if (body.layout_type !== undefined) patch.layout_type = body.layout_type
    if (body.validate_before_next !== undefined) patch.validate_before_next = body.validate_before_next ? 1 : 0
    if (body.summary_enabled !== undefined) patch.summary_enabled = body.summary_enabled ? 1 : 0
    if (body.summary_show_all !== undefined) patch.summary_show_all = body.summary_show_all ? 1 : 0
    if (body.ai_enabled !== undefined) patch.ai_enabled = body.ai_enabled ? 1 : 0
    if (body.conditions !== undefined) patch.conditions = body.conditions == null ? null : JSON.stringify(body.conditions)
    if (body.allow_clone !== undefined) patch.allow_clone = body.allow_clone ? 1 : 0
    if (body.allow_schedule !== undefined) patch.allow_schedule = body.allow_schedule ? 1 : 0
    if (body.allow_disable_pickers !== undefined) patch.allow_disable_pickers = body.allow_disable_pickers ? 1 : 0
    if (body.addendum_layout_id !== undefined) patch.addendum_layout_id = body.addendum_layout_id ?? null
    if (body.workflow_template_id !== undefined) patch.workflow_template_id = body.workflow_template_id ?? null
    if (body.single_active_addendum !== undefined) patch.single_active_addendum = body.single_active_addendum ? 1 : 0
    if (body.addendum_default_view !== undefined) patch.addendum_default_view = body.addendum_default_view ? 1 : 0
    if (body.record_conditions !== undefined) patch.record_conditions = body.record_conditions == null ? null : JSON.stringify(body.record_conditions)
    if (body.default_values !== undefined) patch.default_values = body.default_values == null ? null : JSON.stringify(body.default_values)

    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'No fields to update' })

    await db('nivaro_collection_layouts').where({ id }).update(patch)
    const updated = await db('nivaro_collection_layouts').where({ id }).first()
    updated.conditions = parseConditions(updated.conditions)
    updated.record_conditions = parseRecordConditions(updated.record_conditions)
    updated.default_values = parseDefaultValues(updated.default_values)

    await logActivity({ action: 'update', user: req.user?.id, collection: 'nivaro_collection_layouts', item: id, req })
    return reply.send({ data: updated })
  })

  // DELETE /collection-layouts/:id — blocked if it is the only layout for the collection
  app.delete('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await db('nivaro_collection_layouts').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const countRow = await db('nivaro_collection_layouts')
      .where({ collection: existing.collection })
      .count('id as c')
      .first()
    const count = Number(countRow?.c ?? 0)

    if (count <= 1) return reply.code(409).send({ error: 'Cannot delete the only layout for a collection' })

    // If deleting the active layout, promote the next one of the SAME type first
    // (activation is type-scoped — grouped and detail defaults are independent).
    if (existing.is_active) {
      const layoutType = existing.layout_type ?? 'grouped'
      const next = await db('nivaro_collection_layouts')
        .where({ collection: existing.collection, layout_type: layoutType })
        .whereNot({ id: Number(id) })
        .orderBy('sort', 'asc')
        .first('id')
      if (next) {
        await db('nivaro_collection_layouts')
          .where({ collection: existing.collection, layout_type: layoutType })
          .update({ is_active: 0 })
        await db('nivaro_collection_layouts').where({ id: next.id }).update({ is_active: 1 })
      }
    }

    await db('nivaro_layout_field_assignments').where({ layout_id: Number(id) }).delete()
    await db('nivaro_field_groups').where({ layout_id: Number(id) }).delete()
    await db('nivaro_collection_layouts').where({ id }).delete()
    await logActivity({ action: 'delete', user: req.user?.id, collection: 'nivaro_collection_layouts', item: id, req })
    return reply.code(204).send()
  })

  // POST /collection-layouts/:id/activate
  app.post('/:id/activate', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await db('nivaro_collection_layouts').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    // Activation is scoped to the layout's type: one active 'grouped' layout
    // (ItemEdit default) and one active 'detail' layout (drill-down default)
    // coexist per collection.
    await db('nivaro_collection_layouts')
      .where({ collection: existing.collection, layout_type: existing.layout_type ?? 'grouped' })
      .update({ is_active: 0 })
    await db('nivaro_collection_layouts').where({ id }).update({ is_active: 1 })

    const updated = await db('nivaro_collection_layouts').where({ id }).first()
    await logActivity({ action: 'update', user: req.user?.id, collection: 'nivaro_collection_layouts', item: id, req })
    return reply.send({ data: updated })
  })

  app.get('/:id/preview-html', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const layout = await db('nivaro_collection_layouts').where({ id }).first()
    if (!layout || layout.layout_type !== 'file') return reply.code(404).send({ error: 'Not found' })

    const [groups, assignments, fieldMeta] = await Promise.all([
      db('nivaro_field_groups').where({ layout_id: Number(id) }).select('id', 'key', 'label', 'sort').orderBy('sort', 'asc'),
      db('nivaro_layout_field_assignments').where({ layout_id: Number(id) }).select('field', 'group_key', 'sort', 'label_override', 'is_visible', 'widget_id', 'input_bindings').orderBy('sort', 'asc'),
      db('nivaro_fields').where({ collection: layout.collection }).select('field', 'label', 'type'),
    ])

    const fieldMetaMap = new Map((fieldMeta as Array<{ field: string; label: string | null; type: string }>).map(f => [f.field, f]))

    const realSections = groups
      .sort((a: { sort: number }, b: { sort: number }) => a.sort - b.sort)
      .map((group: { id: number; key: string; label: string; sort: number }) => {
        const groupFields = (assignments as Array<{ field: string; group_key: string | null; sort: number; label_override: string | null; is_visible: number | boolean | null }>)
          .filter(a =>
            (group.key ? a.group_key === group.key : a.group_key === String(group.id)) &&
            a.is_visible !== 0 && a.is_visible !== false &&
            !a.field.startsWith('__')
          )
          .sort((a, b) => a.sort - b.sort)
          .map(a => {
            const meta = fieldMetaMap.get(a.field)
            return { label: a.label_override ?? meta?.label ?? a.field, value: `[${a.field}]` }
          })
        return { label: group.label, fields: groupFields }
      })
      .filter((s: { fields: unknown[] }) => s.fields.length > 0)

    const sections = realSections.length > 0 ? realSections : [
      { label: 'No fields configured', fields: [
        { label: 'Groups in layout', value: String(groups.length) },
        { label: 'Assignments in layout', value: String((assignments as unknown[]).length) },
        { label: 'Fix', value: 'Drag fields into groups in the Layouts tab to populate this PDF.' },
      ]},
    ]

    const previewData = {
      coverTitle: layout.pdf_cover_title_field ? `[${layout.pdf_cover_title_field}]` : 'Document Title',
      coverSubtitle: layout.pdf_cover_subtitle ?? 'Preview · Real Layout',
      logoUrl: null as string | null,
      collectionLabel: layout.collection ?? 'Collection',
      generatedAt: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      generatedBy: 'Preview',
      coverEnabled: Boolean(layout.pdf_cover_enabled ?? true),
      sections,
    }

    const theme = layout.pdf_theme ?? 'classic'
    let html: string
    if (theme === 'minimal') html = minimalTheme(previewData)
    else if (theme === 'executive') html = executiveTheme(previewData)
    else html = classicTheme(previewData)

    return reply.header('Content-Type', 'text/html; charset=utf-8').send(html)
  })

  // POST /collection-layouts/:id/generate-pdf
  app.post('/:id/generate-pdf', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { collection, item_id } = req.body as { collection: string; item_id: string | number }

    if (!collection || item_id == null) {
      return reply.code(400).send({ error: 'collection and item_id are required' })
    }

    const layout = await db('nivaro_collection_layouts').where({ id }).first()
    if (!layout) return reply.code(404).send({ error: 'Layout not found' })
    if (layout.layout_type !== 'file') return reply.code(400).send({ error: 'Layout is not a file layout' })

    let item: Record<string, unknown>
    try {
      item = await readOne(req.user!, collection, String(item_id), req.workspaceId ?? undefined) as Record<string, unknown>
    } catch (err) {
      if (err instanceof ForbiddenError) return reply.code(403).send({ error: 'Forbidden' })
      if (err instanceof ItemNotFoundError) return reply.code(404).send({ error: 'Item not found' })
      throw err
    }

    const [groups, assignments, fieldMeta, colMeta, settings, directRelations] = await Promise.all([
      db('nivaro_field_groups')
        .where({ layout_id: Number(id) })
        .select('id', 'key', 'label', 'sort')
        .orderBy('sort', 'asc'),
      db('nivaro_layout_field_assignments')
        .where({ layout_id: Number(id) })
        .select('field', 'group_key', 'sort', 'label_override', 'is_visible', 'col_span', 'overrides')
        .orderBy('sort', 'asc'),
      db('nivaro_fields').where({ collection }).select('field', 'label', 'type', 'interface', 'options'),
      db('nivaro_collections').where({ collection }).first('display_name'),
      db('nivaro_settings').where({ id: 1 }).first('logo_url').catch(() => null),
      db('nivaro_relations')
        .where('many_collection', collection)
        .orWhere('one_collection', collection)
        .select('many_collection', 'many_field', 'one_collection', 'one_field', 'junction_field'),
    ])

    // For M2M: also fetch the junction→other relations so we can resolve display values
    const m2mJunctions = (directRelations as Array<{ many_collection: string; junction_field: string | null; one_collection: string | null }>)
      .filter(r => r.one_collection === collection && r.junction_field != null)
      .map(r => r.many_collection)
    const junctionRelations = m2mJunctions.length > 0
      ? await db('nivaro_relations')
          .whereIn('many_collection', m2mJunctions)
          .select('many_collection', 'many_field', 'one_collection', 'one_field', 'junction_field')
      : []
    const relations = [...directRelations, ...junctionRelations] as Array<{ many_collection: string; many_field: string; one_collection: string | null; one_field: string | null; junction_field: string | null }>

    const collectionLabel = (colMeta?.display_name as string | null) ?? collection
    const logoUrl = (settings?.logo_url as string | null) ?? null
    const generatedBy = req.user?.first_name
      ? `${req.user.first_name} ${req.user.last_name ?? ''}`.trim()
      : (req.user?.email ?? 'System')

    const pdfBuffer = await generatePdfFromLayout({
      layout,
      collectionLabel,
      collection,
      item,
      groups,
      assignments,
      fieldMeta,
      relations,
      logoUrl,
      generatedBy,
    })

    await logActivity({
      action: 'pdf-generate',
      user: req.user?.id,
      collection,
      item: String(item_id),
      req,
    })

    const safeFilename = `${collection}-${item_id}`.replace(/[^a-zA-Z0-9_-]/g, '_')

    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${safeFilename}.pdf"`)
      .send(pdfBuffer)
  })

  // POST /collection-layouts/:id/generate-and-attach
  // Generates PDF for an item and attaches it to a file M2M/O2M field on the item.
  app.post('/:id/generate-and-attach', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { collection, item_id, attach_field, filename_template } = req.body as {
      collection: string; item_id: string | number; attach_field: string; filename_template?: string | null
    }

    if (!collection || item_id == null || !attach_field) {
      return reply.code(400).send({ error: 'collection, item_id, and attach_field are required' })
    }

    const layout = await db('nivaro_collection_layouts').where({ id }).first()
    if (!layout) return reply.code(404).send({ error: 'Layout not found' })

    // Check read AND update permission before generating/attaching
    if (!req.isAdmin) {
      const [canRead, canUpdate] = await Promise.all([
        can(req.user!, 'read', collection),
        can(req.user!, 'update', collection),
      ])
      if (!canRead || !canUpdate) return reply.code(403).send({ error: 'Forbidden' })
    }

    let item: Record<string, unknown>
    try {
      item = await readOne(req.user!, collection, String(item_id), req.workspaceId ?? undefined) as Record<string, unknown>
    } catch (err) {
      if (err instanceof ForbiddenError) return reply.code(403).send({ error: 'Forbidden' })
      if (err instanceof ItemNotFoundError) return reply.code(404).send({ error: 'Item not found' })
      throw err
    }

    const [groups, assignments, fieldMeta, colMeta, settings, directRelations] = await Promise.all([
      db('nivaro_field_groups').where({ layout_id: Number(id) }).select('id','key','label','sort').orderBy('sort','asc'),
      db('nivaro_layout_field_assignments').where({ layout_id: Number(id) }).select('field','group_key','sort','label_override','is_visible','col_span','overrides','widget_id','input_bindings').orderBy('sort','asc'),
      db('nivaro_fields').where({ collection }).select('field','label','type','interface','options'),
      db('nivaro_collections').where({ collection }).first('display_name'),
      db('nivaro_settings').where({ id: 1 }).first('logo_url').catch(() => null),
      db('nivaro_relations').where('many_collection', collection).orWhere('one_collection', collection)
        .select('many_collection','many_field','one_collection','one_field','junction_field'),
    ])

    const m2mJunctions = (directRelations as Array<{ many_collection: string; junction_field: string | null; one_collection: string | null }>)
      .filter(r => r.one_collection === collection && r.junction_field != null)
      .map(r => r.many_collection)
    const junctionRelations = m2mJunctions.length > 0
      ? await db('nivaro_relations').whereIn('many_collection', m2mJunctions)
          .select('many_collection','many_field','one_collection','one_field','junction_field')
      : []
    const relations = [...directRelations, ...junctionRelations] as Array<{
      many_collection: string; many_field: string; one_collection: string | null; one_field: string | null; junction_field: string | null
    }>

    const collectionLabel = (colMeta?.display_name as string | null) ?? collection
    const logoUrl = (settings?.logo_url as string | null) ?? null
    const generatedBy = req.user?.first_name
      ? `${req.user.first_name} ${req.user.last_name ?? ''}`.trim()
      : (req.user?.email ?? 'System')

    const pdfBuffer = await generatePdfFromLayout({
      layout, collectionLabel, collection, item, groups, assignments, fieldMeta, relations, logoUrl, generatedBy,
    })

    // Save PDF to file storage
    const fileId = randomUUID()
    const resolvedName = filename_template
      ? filename_template.replace(/\{\{(\w+)\}\}/g, (_: string, key: string) => {
          const v = item[key]
          return v != null && v !== '' ? String(v).replace(/[^a-zA-Z0-9_-]/g, '_') : key
        })
      : null
    const safeBase = (resolvedName ?? `${collection}-${item_id}`).replace(/[^a-zA-Z0-9_-]/g, '_')
    const diskName = `${fileId}.pdf`
    const provider = getStorageProviderName()
    await getStorage().put(diskName, pdfBuffer, 'application/pdf')
    const fileRow = {
      id: fileId,
      storage: provider,
      storage_provider: provider,
      filename_disk: diskName,
      filename_download: `${safeBase}.pdf`,
      title: safeBase,
      type: 'application/pdf',
      folder: null,
      uploaded_by: req.user!.id,
      uploaded_on: new Date(),
      filesize: pdfBuffer.length,
    }
    await db('nivaro_files').insert(fileRow)

    // Attach file to the item via the relation for attach_field
    // Require exact match using the same alias derivation as the config picker
    const junctionRels = (directRelations as Array<{ many_collection: string; many_field: string; one_collection: string | null; one_field: string | null; junction_field: string | null }>)
      .filter(r => r.one_collection === collection && r.junction_field != null)
    const getFieldAlias = (jr: { one_field: string | null; many_collection: string }) => {
      if (jr.one_field && jr.one_field !== 'id') return jr.one_field
      return jr.many_collection
        .replace(new RegExp(`^${collection}_?|_?${collection}$`, 'i'), '')
        .replace(/^_|_$/g, '') || jr.many_collection
    }
    let attached = false
    const targetJr = junctionRels.find(jr => getFieldAlias(jr) === attach_field)
    if (!targetJr) {
      return reply.code(400).send({ error: `No M2M relation found for field '${attach_field}' on collection '${collection}'` })
    }
    // targetJr encodes both FK columns:
    //   many_field      = junction column pointing to the parent (item_id side)
    //   junction_field  = junction column pointing to the related files record
    if (!targetJr.junction_field) {
      return reply.code(400).send({ error: `Relation '${attach_field}' does not link to nivaro_files` })
    }
    try {
      await db(targetJr.many_collection).insert({
        [targetJr.many_field]: item_id,
        [targetJr.junction_field]: fileId,
      })
      attached = true
    } catch { /* duplicate/constraint — file already attached */ }

    await logActivity({ action: 'pdf-generate-attach', user: req.user?.id, collection, item: String(item_id), req })

    return reply.send({ data: { file_id: fileId, attached } })
  })

  // POST /collection-layouts/:id/clone
  app.post('/:id/clone', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const source = await db('nivaro_collection_layouts').where({ id }).first()
    if (!source) return reply.code(404).send({ error: 'Not found' })

    const body = req.body as { name: string }
    if (!body.name) return reply.code(400).send({ error: 'name is required' })

    const maxSortRow = await db('nivaro_collection_layouts')
      .where({ collection: source.collection })
      .max('sort as m')
      .first()
    const maxSort = (maxSortRow?.m as number | null) ?? -1

    try {
      await db('nivaro_collection_layouts')
        .insert({ collection: source.collection, name: body.name, is_active: 0, sort: maxSort + 1 })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : ''
      if (msg.toLowerCase().includes('unique') || msg.toLowerCase().includes('duplicate')) {
        return reply.code(409).send({ error: 'A layout with that name already exists' })
      }
      throw err
    }
    const newLayout = await db('nivaro_collection_layouts')
      .where({ collection: source.collection, name: body.name })
      .orderBy('id', 'desc')
      .first()
    const newId = newLayout.id

    // Clone groups
    const groups = await db('nivaro_field_groups').where({ layout_id: Number(id) }).select('*')
    for (const g of groups) {
      await db('nivaro_field_groups').insert({
        collection: g.collection,
        key: g.key,
        label: g.label,
        type: g.type,
        icon: g.icon ?? null,
        sort: g.sort,
        is_collapsed: g.is_collapsed,
        layout_id: newId
      })
    }

    // Clone field assignments
    const assignments = await db('nivaro_layout_field_assignments')
      .where({ layout_id: Number(id) })
      .select('field', 'group_key', 'sort')
    if (assignments.length > 0) {
      await db('nivaro_layout_field_assignments').insert(
        assignments.map((a: { field: string; group_key: string | null; sort: number }) => ({
          layout_id: newId,
          field: a.field,
          group_key: a.group_key,
          sort: a.sort
        }))
      )
    }

    await logActivity({ action: 'create', user: req.user?.id, collection: 'nivaro_collection_layouts', item: String(newId), req })
    return reply.code(201).send({ data: newLayout })
  })

  // GET /collection-layouts/:id/assignments
  app.get('/:id/assignments', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const layout = await db('nivaro_collection_layouts').where({ id }).first()
    if (!layout) return reply.code(404).send({ error: 'Not found' })
    const rows = await db('nivaro_layout_field_assignments')
      .where({ layout_id: Number(id) })
      .select('field', 'group_key', 'sort', 'label_override', 'is_visible', 'default_expanded', 'show_row_revisions', 'allow_revision_restore', 'lock_conditions', 'overrides', 'widget_id', 'input_bindings')
      .orderBy('sort', 'asc')
    return reply.send({ data: rows })
  })

  // PATCH /collection-layouts/:id/ungrouped-sort — update only the __ungrouped_pos__ row
  app.patch('/:id/ungrouped-sort', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { ungrouped_sort } = req.body as { ungrouped_sort: number }
    await db('nivaro_layout_field_assignments')
      .where({ layout_id: Number(id), field: '__ungrouped_pos__' })
      .delete()
    await db('nivaro_layout_field_assignments')
      .insert({ layout_id: Number(id), field: '__ungrouped_pos__', group_key: null, sort: ungrouped_sort })
    return reply.send({ data: { ungrouped_sort } })
  })

  // PUT /collection-layouts/:id/assignments — bulk replace
  app.put('/:id/assignments', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const layout = await db('nivaro_collection_layouts').where({ id }).first()
    if (!layout) return reply.code(404).send({ error: 'Not found' })

    const body = req.body as {
      assignments: Array<{
        field: string
        group_key: string | null
        sort: number
        label_override?: string | null
        is_visible?: boolean
        default_expanded?: boolean
        col_span?: number | null
        overrides?: Record<string, unknown> | null
        show_row_revisions?: boolean
        allow_revision_restore?: boolean | null
        lock_conditions?: string | null
        input_bindings?: unknown
        widget_id?: number | null
        show_approval_chain?: boolean
      }>
    }
    if (!Array.isArray(body.assignments)) return reply.code(400).send({ error: 'assignments array required' })

    await db.transaction(async (trx) => {
      await trx('nivaro_layout_field_assignments').where({ layout_id: Number(id) }).delete()
      if (body.assignments.length > 0) {
        await trx('nivaro_layout_field_assignments').insert(
          body.assignments.map((a) => ({
            layout_id: Number(id),
            field: a.field,
            group_key: a.group_key ?? null,
            sort: a.sort,
            label_override: a.label_override ?? null,
            is_visible: a.is_visible === false ? 0 : 1,
            default_expanded: a.default_expanded === false ? 0 : 1,
            col_span: a.col_span ?? null,
            overrides: a.overrides != null ? JSON.stringify(a.overrides) : null,
            show_row_revisions: a.show_row_revisions ? 1 : 0,
            allow_revision_restore: a.allow_revision_restore === false ? 0 : 1,
            lock_conditions: a.lock_conditions ?? null,
            input_bindings: a.input_bindings != null ? JSON.stringify(a.input_bindings) : null,
            widget_id: a.widget_id ?? null,
            show_approval_chain: a.show_approval_chain ? 1 : 0,
          }))
        )
      }
    })

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_collection_layouts',
      item: id,
      comment: `assignments: ${body.assignments.length} field(s)`,
      req
    })

    const rows = await db('nivaro_layout_field_assignments')
      .where({ layout_id: Number(id) })
      .select('field', 'group_key', 'sort', 'label_override', 'is_visible', 'default_expanded', 'col_span', 'overrides', 'show_row_revisions', 'allow_revision_restore', 'lock_conditions', 'input_bindings', 'widget_id', 'show_approval_chain')
      .orderBy('sort', 'asc')
    return reply.send({ data: rows })
  })
}
