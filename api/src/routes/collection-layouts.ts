import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

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
      db('nivaro_field_groups').where({ layout_id: layout.id }).select('id','key','label','type','icon','sort','is_collapsed','container_id','tab_mode','hide_when_empty','visibility_mode','summary_fields','summary_hide_empty').orderBy('sort', 'asc'),
      db('nivaro_layout_field_assignments')
        .where({ layout_id: layout.id })
        .select('field', 'group_key', 'sort', 'label_override', 'is_visible', 'default_expanded', 'show_row_revisions', 'col_span', 'overrides')
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
    const { collection, active } = req.query as { collection?: string; active?: string }
    if (!collection) return reply.code(400).send({ error: 'collection is required' })

    let q = db('nivaro_collection_layouts')
      .where({ collection })
      .orderBy('sort', 'asc')
      .select('id', 'collection', 'name', 'slug', 'is_active', 'sort', 'created_at', 'disable_comments', 'disable_tasks', 'disable_revisions', 'disable_clone', 'disable_delete', 'accordion_mode', 'tab_mode', 'validate_before_next', 'summary_enabled', 'summary_show_all', 'summary_hide_empty', 'ai_enabled', 'conditions', 'allow_clone', 'allow_schedule', 'allow_disable_pickers', 'layout_type', 'row_order_field')
    if (active === 'true') q = q.where({ is_active: 1 })

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

    const body = req.body as Partial<{ name: string; slug: string | null; sort: number; disable_comments: boolean; disable_tasks: boolean; disable_revisions: boolean; disable_clone: boolean; disable_delete: boolean; accordion_mode: boolean; tab_mode: string; validate_before_next: boolean; summary_enabled: boolean; summary_show_all: boolean; summary_hide_empty: boolean; ai_enabled: boolean; conditions: { role_ids?: string[] } | null; allow_clone: boolean; allow_schedule: boolean; allow_disable_pickers: boolean; layout_type: string; row_order_field: string | null }>
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
      .select('field', 'group_key', 'sort', 'label_override', 'is_visible', 'default_expanded', 'show_row_revisions', 'col_span', 'overrides')
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
        col_span?: number | null
        overrides?: Record<string, unknown> | null
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
            col_span: a.col_span ?? null,
            overrides: a.overrides != null ? JSON.stringify(a.overrides) : null
          }))
        )
      }
    })

    const rows = await db('nivaro_layout_field_assignments')
      .where({ layout_id: Number(id) })
      .select('field', 'group_key', 'sort', 'label_override', 'is_visible', 'default_expanded', 'show_row_revisions', 'col_span', 'overrides')
      .orderBy('sort', 'asc')
    return reply.send({ data: rows })
  })
}
