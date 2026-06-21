import { randomUUID } from 'crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { generatePdfFromLayout } from '../services/pdf-layout.js'
import { classicTheme, executiveTheme, minimalTheme } from '../services/pdf-layout-themes.js'
import { ForbiddenError, ItemNotFoundError, readOne } from '../services/items.js'
import { can } from '../services/permissions.js'
import { getStorage, getStorageProviderName } from '../services/storage/index.js'

type LayoutConditions = { role_ids?: string[] } | null

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

// Resolve the best-matching layout for a collection given the user's role.
// Conditional layouts (conditions.role_ids includes userRoleId) win over the
// default (is_active=1) layout; among conditional matches the most specific
// (most role_ids) wins, ties resolved by first match. Returns the raw DB row
// (conditions still as a JSON string) or null when no layout exists.
async function resolveLayout(collection: string, userRoleId: string | null | undefined) {
  const layouts = await db('nivaro_collection_layouts')
    .where({ collection })
    .whereNot({ layout_type: 'file' })
    .orderByRaw('is_active desc, sort asc')

  if (layouts.length === 0) return null

  if (userRoleId) {
    let best: { row: (typeof layouts)[number]; matches: number } | null = null
    for (const row of layouts) {
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
  return layouts.find((l) => l.is_active) ?? layouts[0]
}

export async function collectionLayoutsRoutes(app: FastifyInstance) {
  // GET /collection-layouts/active?collection=x — MUST be before /:id
  app.get('/active', { preHandler: authenticate }, async (req, reply) => {
    const { collection, slug } = req.query as { collection?: string; slug?: string }
    if (!collection) return reply.code(400).send({ error: 'collection is required' })

    const userRoleId = req.isAdmin ? null : (req.user?.role ?? null)
    let layout: Awaited<ReturnType<typeof resolveLayout>>
    if (slug) {
      const candidate = await db('nivaro_collection_layouts').where({ collection, slug }).first() ?? null
      if (candidate) {
        const cond = parseConditions(candidate.conditions)
        const roleIds = cond?.role_ids
        // Admins can access any layout; for non-admins, the layout must be unconditioned or match their role
        const accessible = req.isAdmin || !Array.isArray(roleIds) || roleIds.length === 0 || (userRoleId != null && roleIds.includes(userRoleId))
        layout = accessible ? candidate : null
      } else {
        layout = null
      }
    } else {
      // Admins always see the default layout (no conditional override).
      layout = await resolveLayout(collection, userRoleId)
    }
    if (!layout) return reply.code(404).send({ error: 'No layout found' })

    layout.conditions = parseConditions(layout.conditions)

    const [groups, assignments] = await Promise.all([
      db('nivaro_field_groups').where({ layout_id: layout.id }).select('id','key','label','type','icon','sort','is_collapsed','container_id','tab_mode','hide_when_empty','visibility_mode','summary_fields','summary_hide_empty','swap_config').orderBy('sort', 'asc'),
      db('nivaro_layout_field_assignments')
        .where({ layout_id: layout.id })
        .select('field', 'group_key', 'sort', 'label_override', 'is_visible', 'default_expanded', 'show_row_revisions', 'show_approval_chain', 'col_span', 'overrides', 'widget_id', 'input_bindings')
        .orderBy('sort', 'asc')
    ])

    const ungroupedRow = assignments.find((a: { field: string; sort: number }) => a.field === '__ungrouped_pos__')
    const ungrouped_sort: number | null = ungroupedRow ? ungroupedRow.sort : null

    return reply.send({ data: { layout, groups, assignments, ungrouped_sort } })
  })

  // GET /collection-layouts?collection=x[&active=true]
  app.get('/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = await db('nivaro_collection_layouts').where({ id }).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    row.conditions = parseConditions(row.conditions)
    return reply.send({ data: row })
  })

  app.get('/', { preHandler: authenticate }, async (req, reply) => {
    const { collection, active, type } = req.query as { collection?: string; active?: string; type?: string }
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
        'pdf_cover_subtitle', 'pdf_show_logo', 'pdf_page_size', 'pdf_orientation', 'pdf_button_label'
      )
    if (active === 'true') q = q.where({ is_active: 1 })
    if (type) {
      q = q.where({ layout_type: type })
      if (type === 'file') q = q.where({ is_active: 1 })
    }

    const rows = await q
    for (const row of rows) row.conditions = parseConditions(row.conditions)
    return reply.send({ data: rows })
  })

  // POST /collection-layouts
  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as { collection: string; name: string; slug?: string; layout_type?: string }
    if (!body.collection || !body.name) return reply.code(400).send({ error: 'collection and name are required' })

    const maxSortRow = await db('nivaro_collection_layouts')
      .where({ collection: body.collection })
      .max('sort as m')
      .first()
    const maxSort = (maxSortRow?.m as number | null) ?? -1

    const autoSlug = body.slug ?? body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    try {
      await db('nivaro_collection_layouts')
        .insert({ collection: body.collection, name: body.name, slug: autoSlug, is_active: 0, sort: maxSort + 1, layout_type: body.layout_type ?? 'grouped' })
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

  // PATCH /collection-layouts/:id
  app.patch('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await db('nivaro_collection_layouts').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const body = req.body as Partial<{
      name: string; slug: string | null; sort: number
      disable_comments: boolean; disable_tasks: boolean; disable_revisions: boolean
      disable_clone: boolean; disable_delete: boolean; accordion_mode: boolean
      tab_mode: string; validate_before_next: boolean; summary_enabled: boolean
      summary_show_all: boolean; summary_hide_empty: boolean; ai_enabled: boolean
      conditions: { role_ids?: string[] } | null
      allow_clone: boolean; allow_schedule: boolean; allow_disable_pickers: boolean
      layout_type: string; row_order_field: string | null
      pdf_theme: string; pdf_template_id: number | null
      pdf_cover_enabled: boolean; pdf_cover_title_field: string | null
      pdf_cover_subtitle: string | null; pdf_show_logo: boolean
      pdf_page_size: string; pdf_orientation: string
      pdf_button_label: string | null
      is_active: boolean
    }>
    const patch: Record<string, unknown> = {}
    if (body.name !== undefined) patch.name = body.name
    if (body.slug !== undefined) patch.slug = body.slug ?? null
    if (body.sort !== undefined) patch.sort = body.sort
    if (body.disable_comments !== undefined) patch.disable_comments = body.disable_comments ? 1 : 0
    if (body.disable_tasks !== undefined) patch.disable_tasks = body.disable_tasks ? 1 : 0
    if (body.disable_revisions !== undefined) patch.disable_revisions = body.disable_revisions ? 1 : 0
    if (body.disable_clone !== undefined) patch.disable_clone = body.disable_clone ? 1 : 0
    if (body.disable_delete !== undefined) patch.disable_delete = body.disable_delete ? 1 : 0
    if (body.accordion_mode !== undefined) patch.accordion_mode = body.accordion_mode ? 1 : 0
    if (body.tab_mode !== undefined) patch.tab_mode = body.tab_mode
    if (body.validate_before_next !== undefined) patch.validate_before_next = body.validate_before_next ? 1 : 0
    if (body.summary_enabled !== undefined) patch.summary_enabled = body.summary_enabled ? 1 : 0
    if (body.summary_show_all !== undefined) patch.summary_show_all = body.summary_show_all ? 1 : 0
    if (body.summary_hide_empty !== undefined) patch.summary_hide_empty = body.summary_hide_empty ? 1 : 0
    if (body.ai_enabled !== undefined) patch.ai_enabled = body.ai_enabled ? 1 : 0
    if (body.conditions !== undefined) patch.conditions = body.conditions == null ? null : JSON.stringify(body.conditions)
    if (body.allow_clone !== undefined) patch.allow_clone = body.allow_clone ? 1 : 0
    if (body.allow_schedule !== undefined) patch.allow_schedule = body.allow_schedule ? 1 : 0
    if (body.allow_disable_pickers !== undefined) patch.allow_disable_pickers = body.allow_disable_pickers ? 1 : 0
    if (body.layout_type !== undefined) patch.layout_type = body.layout_type
    if (body.row_order_field !== undefined) patch.row_order_field = body.row_order_field ?? null
    if (body.pdf_theme !== undefined) patch.pdf_theme = body.pdf_theme
    if (body.pdf_template_id !== undefined) patch.pdf_template_id = body.pdf_template_id ?? null
    if (body.pdf_cover_enabled !== undefined) patch.pdf_cover_enabled = body.pdf_cover_enabled ? 1 : 0
    if (body.pdf_cover_title_field !== undefined) patch.pdf_cover_title_field = body.pdf_cover_title_field ?? null
    if (body.pdf_cover_subtitle !== undefined) patch.pdf_cover_subtitle = body.pdf_cover_subtitle ?? null
    if (body.pdf_show_logo !== undefined) patch.pdf_show_logo = body.pdf_show_logo ? 1 : 0
    if (body.pdf_page_size !== undefined) patch.pdf_page_size = body.pdf_page_size
    if (body.pdf_orientation !== undefined) patch.pdf_orientation = body.pdf_orientation
    if (body.pdf_button_label !== undefined) patch.pdf_button_label = body.pdf_button_label ?? null
    if (body.is_active !== undefined && existing.layout_type === 'file') patch.is_active = body.is_active ? 1 : 0

    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'No fields to update' })

    await db('nivaro_collection_layouts').where({ id }).update(patch)
    const updated = await db('nivaro_collection_layouts').where({ id }).first()
    updated.conditions = parseConditions(updated.conditions)

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

    // If deleting the active layout, promote the next one first
    if (existing.is_active) {
      const next = await db('nivaro_collection_layouts')
        .where({ collection: existing.collection })
        .whereNot({ id: Number(id) })
        .orderBy('sort', 'asc')
        .first('id')
      if (next) {
        await db('nivaro_collection_layouts').where({ collection: existing.collection }).update({ is_active: 0 })
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

    await db('nivaro_collection_layouts')
      .where({ collection: existing.collection })
      .update({ is_active: 0 })
    await db('nivaro_collection_layouts').where({ id }).update({ is_active: 1 })

    const updated = await db('nivaro_collection_layouts').where({ id }).first()
    await logActivity({ action: 'update', user: req.user?.id, collection: 'nivaro_collection_layouts', item: id, req })
    return reply.send({ data: updated })
  })

  // GET /collection-layouts/:id/preview-html — returns theme HTML with real groups and placeholder values
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
    // Migrated Directus DBs still have directus_files as a physical table with legacy FK constraints.
    // Insert there too so junction tables with directus_files_id FK can reference this file.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { storage_provider: _sp, ...directusFileRow } = fileRow
    await db('directus_files').insert({ ...directusFileRow, uploaded_by: null }).catch(() => { /* absent on clean installs */ })

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

    const body = req.body as { name: string; slug?: string }
    if (!body.name) return reply.code(400).send({ error: 'name is required' })

    const maxSortRow = await db('nivaro_collection_layouts')
      .where({ collection: source.collection })
      .max('sort as m')
      .first()
    const maxSort = (maxSortRow?.m as number | null) ?? -1

    try {
      await db('nivaro_collection_layouts')
        .insert({ collection: source.collection, name: body.name, slug: body.slug ?? body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), is_active: 0, sort: maxSort + 1 })
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
      .select('field', 'group_key', 'sort', 'label_override', 'is_visible', 'default_expanded', 'show_row_revisions', 'show_approval_chain', 'col_span', 'overrides', 'widget_id', 'input_bindings')
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
        show_row_revisions?: boolean
        show_approval_chain?: boolean
        col_span?: number | null
        overrides?: Record<string, unknown> | null
        widget_id?: number | null
        input_bindings?: unknown[] | null
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
            show_row_revisions: a.show_row_revisions === true ? 1 : 0,
            show_approval_chain: a.show_approval_chain === true ? 1 : 0,
            col_span: a.col_span ?? null,
            overrides: a.overrides != null ? JSON.stringify(a.overrides) : null,
            widget_id: a.widget_id ?? null,
            input_bindings: a.input_bindings != null ? JSON.stringify(a.input_bindings) : null
          }))
        )
      }
    })

    const rows = await db('nivaro_layout_field_assignments')
      .where({ layout_id: Number(id) })
      .select('field', 'group_key', 'sort', 'label_override', 'is_visible', 'default_expanded', 'show_row_revisions', 'show_approval_chain', 'col_span', 'overrides', 'widget_id', 'input_bindings')
      .orderBy('sort', 'asc')
    return reply.send({ data: rows })
  })
}
