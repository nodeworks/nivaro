import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { markConfigRead, nameConfigCollection } from '../services/config-live.js'
import {
  BlockError,
  type BlockKind,
  blockFields,
  extractForm,
  extractSection,
  type LayoutBlock,
  mapBlock,
  parseBlock,
  planBlock
} from '../services/layout-blocks.js'
import {
  GROUP_PATCH_KEYS,
  type GroupRow,
  type LayoutBundle,
  loadLayoutBundle,
  PLACEMENT_PATCH_KEYS,
  type PlacementRow,
  runLayoutOps
} from '../services/layout-ops.js'

/**
 * Reusing layout parts (registered under /collection-layouts, admin only):
 * - #2594 layout templates and #2606 section library: nivaro_layout_templates
 *   rows (kind 'form' | 'section') holding a LayoutBlock by field name.
 * - #2584 copy a section to another layout: POST /:id/copy-section.
 * - POST /blocks/plan: the ops that drop a block on the layout the editor has
 *   open — the editor applies them through its draft (one undo step).
 * Every layout change goes through runLayoutOps, like any editor save.
 */

const TABLE = 'nivaro_layout_templates'
const KINDS: BlockKind[] = ['form', 'section']

type FieldMap = Record<string, string | null>

interface TemplateRow {
  id: number
  kind: BlockKind
  name: string
  description: string | null
  source_collection: string | null
  payload: string
  created_by: string | null
  created_at: unknown
  updated_at: unknown
}

export interface LoadedTemplate {
  id: number
  kind: BlockKind
  name: string
  source_collection: string | null
  layout_type: string
  block: LayoutBlock
}

async function loadTemplate(id: unknown): Promise<LoadedTemplate | null> {
  const n = Number(id)
  if (!Number.isInteger(n) || n <= 0) return null
  const row = (await db(TABLE).where({ id: n }).first()) as TemplateRow | undefined
  const block = row ? parseBlock(row.payload) : null
  if (!row || !block) return null
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    source_collection: row.source_collection,
    layout_type: block.layout_type ?? 'grouped',
    block
  }
}

/** A saved form template (null for a section or a missing id). */
export async function loadFormTemplate(id: unknown): Promise<LoadedTemplate | null> {
  const t = await loadTemplate(id)
  return t?.kind === 'form' ? t : null
}

/** The target collection's field names (relation aliases included). */
async function collectionFieldNames(collection: string): Promise<Set<string>> {
  const rows = (await db('nivaro_fields').where({ collection }).select('field')) as Array<{
    field: string
  }>
  return new Set(rows.map((r) => String(r.field)))
}

/**
 * How a source field lands on `target`: the admin's choice from `map` (null or
 * '' = leave it out; a name the target lacks is left out too), else the same
 * name when the target collection has it.
 */
export function fieldResolver(map: FieldMap, targetFields: Set<string>) {
  return (f: string): string | null => {
    if (Object.hasOwn(map, f)) {
      const to = map[f]
      return typeof to === 'string' && to && targetFields.has(to) ? to : null
    }
    return targetFields.has(f) ? f : null
  }
}

const cleanMap = (raw: unknown): FieldMap => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: FieldMap = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>))
    out[k] = typeof v === 'string' ? v : null
  return out
}

/**
 * The editor may post the bundle it shows (edits not saved yet); only known
 * group / placement settings are kept from it, the layout row is the stored one.
 */
function bundleFrom(posted: unknown, stored: LayoutBundle): LayoutBundle {
  const b = posted as { groups?: unknown; placements?: unknown } | null
  if (!b || !Array.isArray(b.groups) || !Array.isArray(b.placements)) return stored
  const keep = (row: Record<string, unknown>, keys: readonly string[]) => {
    const out: Record<string, unknown> = {}
    for (const k of keys) if (row[k] !== undefined) out[k] = row[k]
    return out
  }
  const groups = (b.groups as Array<Record<string, unknown>>)
    .filter((g) => g && typeof g.key === 'string')
    .map(
      (g) =>
        ({
          ...keep(g, GROUP_PATCH_KEYS),
          key: g.key,
          parent_key: typeof g.parent_key === 'string' ? g.parent_key : null,
          sort: Number(g.sort ?? 0),
          label: String(g.label ?? ''),
          type: String(g.type ?? 'section')
        }) as GroupRow
    )
  const placements = (b.placements as Array<Record<string, unknown>>)
    .filter((p) => p && typeof p.field === 'string')
    .map(
      (p) =>
        ({
          ...keep(p, PLACEMENT_PATCH_KEYS),
          field: p.field,
          group_key: typeof p.group_key === 'string' ? p.group_key : null,
          sort: Number(p.sort ?? 0)
        }) as PlacementRow
    )
  return { ...stored, groups, placements }
}

/** The block a request names: a saved template, or a section of a layout. */
async function sourceBlock(src: {
  template_id?: unknown
  layout_id?: unknown
  group_key?: unknown
  bundle?: unknown
}): Promise<{ block: LayoutBlock; collection: string | null } | { error: string; code: number }> {
  if (src.template_id != null) {
    const t = await loadTemplate(src.template_id)
    if (!t) return { error: 'No template with that id', code: 404 }
    return { block: t.block, collection: t.source_collection }
  }
  const id = Number(src.layout_id)
  if (!Number.isInteger(id) || id <= 0) return { error: 'layout_id required', code: 400 }
  const stored = await loadLayoutBundle(db, id)
  if (!stored) return { error: 'No layout with that id', code: 404 }
  const bundle = bundleFrom(src.bundle, stored)
  try {
    const block =
      typeof src.group_key === 'string'
        ? extractSection(bundle, src.group_key)
        : extractForm(bundle)
    return { block, collection: String(stored.layout.collection) }
  } catch (err) {
    if (err instanceof BlockError) return { error: err.message, code: 400 }
    throw err
  }
}

/** #2594: a new layout's content from a form template (POST /collection-layouts). */
export async function applyTemplateToNewLayout(
  layout: { id: number; collection: string },
  template: LoadedTemplate,
  map: FieldMap,
  userId: string | null | undefined
): Promise<{ error: string } | { unmapped: string[]; dropped: string[]; already: string[] }> {
  const target = await loadLayoutBundle(db, Number(layout.id))
  if (!target) return { error: 'The new layout disappeared' }
  const fields = await collectionFieldNames(layout.collection)
  const mapped = mapBlock(
    template.block,
    fieldResolver(cleanMap(map), fields),
    template.source_collection !== layout.collection
  )
  try {
    const plan = planBlock(mapped.block, target, { settings: true })
    const res = await runLayoutOps(
      Number(layout.id),
      { ops: plan.ops, base_rev: target.rev, note: `from template ${template.name}` },
      userId
    )
    if (res.status !== 200) return { error: 'error' in res ? res.error : 'Could not apply it' }
    return { unmapped: mapped.unmapped, dropped: mapped.dropped, already: plan.already }
  } catch (err) {
    if (err instanceof BlockError) return { error: err.message }
    throw err
  }
}

function templateOut(row: TemplateRow) {
  const block = parseBlock(row.payload)
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    source_collection: row.source_collection,
    layout_type: block?.layout_type ?? null,
    fields: block ? blockFields(block) : [],
    sections: block ? block.groups.filter((g) => g.parent_key === null).length : 0,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

export async function layoutReuseRoutes(app: FastifyInstance) {
  // GET /collection-layouts/templates?kind=form|section
  app.get('/templates', { preHandler: requireAdmin }, async (req, reply) => {
    const { kind } = req.query as { kind?: string }
    if (kind !== undefined && !KINDS.includes(kind as BlockKind))
      return reply.code(400).send({ error: "kind must be 'form' or 'section'" })
    const q = db(TABLE).orderBy([{ column: 'name' }, { column: 'id' }])
    if (kind) q.where({ kind })
    const rows = (await q) as TemplateRow[]
    return reply.send({ data: rows.map(templateOut) })
  })

  app.get('/templates/:tid', { preHandler: requireAdmin }, async (req, reply) => {
    const { tid } = req.params as { tid: string }
    const row = (await db(TABLE)
      .where({ id: Number(tid) || 0 })
      .first()) as TemplateRow | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data: { ...templateOut(row), block: parseBlock(row.payload) } })
  })

  // POST /collection-layouts/templates { kind, name, description?, layout_id, group_key?, bundle? }
  // Saves a whole form (kind form) or one section (kind section) by field name.
  app.post('/templates', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      kind?: string
      name?: string
      description?: string | null
      layout_id?: unknown
      group_key?: unknown
      bundle?: unknown
    }
    if (!KINDS.includes(body.kind as BlockKind))
      return reply.code(400).send({ error: "kind must be 'form' or 'section'" })
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name || name.length > 200)
      return reply.code(400).send({ error: 'A name (up to 200 characters) is required' })
    if (body.kind === 'section' && typeof body.group_key !== 'string')
      return reply.code(400).send({ error: 'group_key names the section to save' })
    const src = await sourceBlock({
      layout_id: body.layout_id,
      group_key: body.kind === 'section' ? body.group_key : undefined,
      bundle: body.bundle
    })
    if ('error' in src) return reply.code(src.code).send({ error: src.error })
    // Saving a template changes no form: no config push to open record pages.
    markConfigRead(req)
    const now = new Date()
    await db(TABLE).insert({
      kind: body.kind,
      name,
      description:
        typeof body.description === 'string' && body.description.trim()
          ? body.description.trim()
          : null,
      source_collection: src.collection,
      payload: JSON.stringify(src.block),
      created_by: req.user?.id ?? null,
      created_at: now,
      updated_at: now
    })
    const row = (await db(TABLE)
      .where({ kind: body.kind, name })
      .orderBy('id', 'desc')
      .first()) as TemplateRow
    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: TABLE,
      item: String(row.id),
      req
    })
    return reply.code(201).send({ data: templateOut(row) })
  })

  app.patch('/templates/:tid', { preHandler: requireAdmin }, async (req, reply) => {
    const { tid } = req.params as { tid: string }
    const body = (req.body ?? {}) as { name?: unknown; description?: unknown }
    const patch: Record<string, unknown> = {}
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name || name.length > 200)
        return reply.code(400).send({ error: 'A name (up to 200 characters) is required' })
      patch.name = name
    }
    if (body.description !== undefined)
      patch.description =
        typeof body.description === 'string' && body.description.trim()
          ? body.description.trim()
          : null
    const id = Number(tid) || 0
    if (!(await db(TABLE).where({ id }).first()))
      return reply.code(404).send({ error: 'Not found' })
    if (Object.keys(patch).length)
      await db(TABLE)
        .where({ id })
        .update({ ...patch, updated_at: new Date() })
    const row = (await db(TABLE).where({ id }).first()) as TemplateRow
    return reply.send({ data: templateOut(row) })
  })

  app.delete('/templates/:tid', { preHandler: requireAdmin }, async (req, reply) => {
    const { tid } = req.params as { tid: string }
    const id = Number(tid) || 0
    if (!(await db(TABLE).where({ id }).first()))
      return reply.code(404).send({ error: 'Not found' })
    await db(TABLE).where({ id }).delete()
    await logActivity({ action: 'delete', user: req.user?.id, collection: TABLE, item: tid, req })
    return reply.code(204).send()
  })

  // POST /collection-layouts/blocks/plan — read-only: the ops that drop a block
  // (a template, or a section of a layout) on the bundle the editor shows.
  // { source: {template_id} | {layout_id, group_key, bundle?}, target_collection,
  //   target_bundle, field_map?, index? } → { ops, already, unmapped, dropped, fields }
  app.post('/blocks/plan', { preHandler: requireAdmin }, async (req, reply) => {
    markConfigRead(req)
    const body = (req.body ?? {}) as {
      source?: Record<string, unknown>
      target_collection?: unknown
      target_bundle?: unknown
      field_map?: unknown
      index?: unknown
    }
    if (typeof body.target_collection !== 'string' || !body.target_collection)
      return reply.code(400).send({ error: 'target_collection required' })
    const tb = body.target_bundle as LayoutBundle | null
    if (!tb || !Array.isArray(tb.groups) || !Array.isArray(tb.placements))
      return reply.code(400).send({ error: 'target_bundle required' })
    const src = await sourceBlock(body.source ?? {})
    if ('error' in src) return reply.code(src.code).send({ error: src.error })
    const fields = await collectionFieldNames(body.target_collection)
    const mapped = mapBlock(
      src.block,
      fieldResolver(cleanMap(body.field_map), fields),
      src.collection !== body.target_collection
    )
    const target: LayoutBundle = {
      layout: { ...(tb.layout ?? {}), id: 0, collection: body.target_collection },
      groups: tb.groups,
      placements: tb.placements,
      rev: ''
    }
    try {
      const plan = planBlock(mapped.block, target, {
        index: typeof body.index === 'number' ? body.index : undefined
      })
      return reply.send({
        ops: plan.ops,
        keys: plan.keys,
        already: plan.already,
        unmapped: mapped.unmapped,
        dropped: mapped.dropped,
        fields: blockFields(src.block)
      })
    } catch (err) {
      if (err instanceof BlockError) return reply.code(400).send({ error: err.message })
      throw err
    }
  })

  // POST /collection-layouts/:id/copy-section — #2584: copy a section of one
  // layout (any collection) onto layout :id, through its ops.
  // { source_layout_id, group_key, source_bundle?, field_map? }
  app.post('/:id/copy-section', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const targetId = Number(id)
    if (!Number.isInteger(targetId) || targetId <= 0)
      return reply.code(400).send({ error: 'id must be a number' })
    const body = (req.body ?? {}) as {
      source_layout_id?: unknown
      group_key?: unknown
      source_bundle?: unknown
      field_map?: unknown
    }
    if (typeof body.group_key !== 'string')
      return reply.code(400).send({ error: 'group_key required' })
    const src = await sourceBlock({
      layout_id: body.source_layout_id,
      group_key: body.group_key,
      bundle: body.source_bundle
    })
    if ('error' in src) return reply.code(src.code).send({ error: src.error })
    // Another writer may save between the read and the write: one retry on a stale rev.
    for (let attempt = 0; attempt < 2; attempt++) {
      const target = await loadLayoutBundle(db, targetId)
      if (!target) return reply.code(404).send({ error: 'Not found' })
      const collection = String(target.layout.collection)
      const mapped = mapBlock(
        src.block,
        fieldResolver(cleanMap(body.field_map), await collectionFieldNames(collection)),
        src.collection !== collection
      )
      let plan: ReturnType<typeof planBlock>
      try {
        plan = planBlock(mapped.block, target)
      } catch (err) {
        if (err instanceof BlockError) return reply.code(400).send({ error: err.message })
        throw err
      }
      const label = src.block.groups[0]?.label || body.group_key
      const res = await runLayoutOps(
        targetId,
        { ops: plan.ops, base_rev: target.rev, note: `before copying ${label} in` },
        req.user?.id
      )
      if (res.status === 409) continue
      if (res.status === 404) return reply.code(404).send({ error: 'Not found' })
      if (res.status === 400) return reply.code(400).send({ error: res.error })
      nameConfigCollection(req, collection)
      await logActivity({
        action: 'update',
        user: req.user?.id,
        collection: 'nivaro_collection_layouts',
        item: id,
        comment: `layout editor: copied section ${label} from layout ${String(body.source_layout_id)}`,
        req
      })
      return reply.send({
        bundle: res.bundle,
        group_key: plan.keys[src.block.groups[0]?.key ?? ''] ?? null,
        already: plan.already,
        unmapped: mapped.unmapped,
        dropped: mapped.dropped
      })
    }
    return reply.code(409).send({ error: 'The layout kept changing; try again' })
  })
}
