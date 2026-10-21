import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { readItems } from '../services/items.js'
import {
  columnFacts,
  countMissing,
  findOrphanPlacements,
  formFields,
  groupI18nSupported,
  isIdent,
  readI18n,
  sampleValueLengths,
  type TranslatableText,
  translationLocales,
  WIDTH_SAMPLE_CAP
} from '../services/layout-inspect.js'
import { withReadGate } from '../services/read-gate.js'

// ─── Layout inspector reads (#2634 #2636 #2637 #2638 #2650 #2665) ─────────────
// Everything the layout editor's inspector, add panel and overview ask about a
// collection beyond its layouts: column types and sizes, how long stored values
// really are, which fields other forms carry, placements that point at
// nothing, missing translations, and the options a picker would offer for a
// sample record. Admin-only and read-only; every layout change still goes
// through POST /collection-layouts/:id/ops.

/** A collection whose table the inspector may read: registered, not a system table. */
async function readableCollection(collection: unknown): Promise<string | null> {
  if (!isIdent(collection) || /^(nivaro|directus)_/i.test(collection)) return null
  const row = await db('nivaro_collections').where({ collection }).first('collection')
  return row ? collection : null
}

function fakeReq(picker: boolean): FastifyRequest {
  return { query: picker ? { picker: '1' } : {} } as unknown as FastifyRequest
}

const isFilter = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0

const and = (parts: Record<string, unknown>[]) =>
  parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : { _and: parts }

export async function layoutInspectRoutes(app: FastifyInstance): Promise<void> {
  // #2636 — the table's columns with type and size.
  app.get('/:collection/columns', { preHandler: requireAdmin }, async (req, reply) => {
    const collection = await readableCollection((req.params as { collection: string }).collection)
    if (!collection) return reply.code(404).send({ error: 'Collection not found' })
    if (!(await db.schema.hasTable(collection))) return reply.send({ data: {} })
    return reply.send({ data: await columnFacts(collection) })
  })

  // #2634 — how long the stored values of one column are: the newest
  // WIDTH_SAMPLE_CAP rows by id, behind the read gate.
  app.get('/:collection/value-lengths', { preHandler: requireAdmin }, async (req, reply) => {
    const collection = await readableCollection((req.params as { collection: string }).collection)
    if (!collection) return reply.code(404).send({ error: 'Collection not found' })
    const { field } = req.query as { field?: string }
    if (!isIdent(field)) return reply.code(400).send({ error: 'field is required' })
    if (!(await db.schema.hasTable(collection)))
      return reply.code(404).send({ error: 'The collection has no table' })
    const cols = await columnFacts(collection)
    const column = Object.keys(cols).find((c) => c.toLowerCase() === field.toLowerCase())
    if (!column) return reply.code(400).send({ error: `"${field}" is not a stored column` })
    const hasId = Object.keys(cols).some((c) => c.toLowerCase() === 'id')
    try {
      const stats = await withReadGate(
        req.user?.id,
        () => sampleValueLengths(collection, column, hasId, WIDTH_SAMPLE_CAP),
        { label: `layout-inspect:lengths:${collection}` }
      )
      return reply.send({ data: { field: column, ...stats } })
    } catch (err) {
      req.log.warn({ err, collection, field }, 'layout-inspect: value lengths failed')
      return reply.code(500).send({ error: 'The stored values could not be read' })
    }
  })

  // #2638 — every layout of the collection with the fields it places.
  app.get('/:collection/form-fields', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    if (!isIdent(collection)) return reply.code(400).send({ error: 'Invalid collection' })
    return reply.send({ data: await formFields(collection) })
  })

  // #2650 — placements that point at a dropped column, a deleted widget, a
  // grid whose table is gone or a section that no longer exists.
  app.get('/:collection/orphans', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    if (!isIdent(collection)) return reply.code(400).send({ error: 'Invalid collection' })
    const layouts = await findOrphanPlacements(collection)
    return reply.send({ data: layouts.filter((l) => l.placements.length > 0) })
  })

  // #2665 — missing translations of layout text (field labels, help text,
  // section labels) per layout, against nivaro_settings.available_locales.
  app.get('/:collection/translations', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    if (!isIdent(collection)) return reply.code(400).send({ error: 'Invalid collection' })
    const [{ base, others }, groupsSupported] = await Promise.all([
      translationLocales(),
      groupI18nSupported()
    ])
    const layouts = (await db('nivaro_collection_layouts')
      .where({ collection })
      .select('id', 'name', 'layout_type')) as Array<{
      id: number
      name: string
      layout_type: string | null
    }>
    const ids = layouts.map((l) => Number(l.id))
    const [assignments, groups, fields] = await Promise.all([
      ids.length
        ? (db('nivaro_layout_field_assignments')
            .whereIn('layout_id', ids)
            .select('layout_id', 'field', 'is_visible', 'overrides') as Promise<
            Array<{ layout_id: number; field: string; is_visible: unknown; overrides: unknown }>
          >)
        : [],
      ids.length
        ? (db('nivaro_field_groups')
            .whereIn('layout_id', ids)
            .select('layout_id', 'type', ...(groupsSupported ? ['i18n'] : [])) as Promise<
            Array<{ layout_id: number; type: string; i18n?: unknown }>
          >)
        : [],
      db('nivaro_fields').where({ collection }).select('field', 'note') as Promise<
        Array<{ field: string; note: string | null }>
      >
    ])
    const noteOf = new Map(fields.map((f) => [f.field, f.note]))
    const rows = layouts.map((l) => {
      const texts: TranslatableText[] = []
      for (const a of assignments) {
        if (Number(a.layout_id) !== Number(l.id) || a.field.startsWith('__')) continue
        if (a.is_visible === false || a.is_visible === 0) continue
        const ov = readI18nOverrides(a.overrides)
        if (ov.label === '') continue // label hidden on this form
        const note = typeof ov.note === 'string' ? ov.note : noteOf.get(a.field)
        texts.push({ keys: note ? ['label', 'help'] : ['label'], i18n: readI18n(ov.i18n) })
      }
      if (groupsSupported)
        for (const g of groups)
          if (
            Number(g.layout_id) === Number(l.id) &&
            ['section', 'tab', 'metadata'].includes(g.type)
          )
            texts.push({ keys: ['label'], i18n: readI18n(g.i18n) })
      const { missing, total } = countMissing(texts, others)
      return {
        layout_id: Number(l.id),
        name: l.name,
        layout_type: l.layout_type || 'grouped',
        missing,
        total
      }
    })
    return reply.send({
      data: { base, locales: others, groups_supported: groupsSupported, layouts: rows }
    })
  })

  // #2637 — the options a relation picker offers. The editor compiles the
  // field's cascade filters and option filter against a sample record with the
  // form's own compilers and sends them as steps; this counts what each step
  // leaves, as the admin, then applies the picker exclusions the way the
  // form's option query does (?picker=1). The target's picker_filter is
  // counted separately: the record form's picker does not apply it.
  app.post('/picker-preview', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      collection?: string
      steps?: Array<{ key?: string; label?: string; filter?: unknown }>
      fields?: string[]
      sort?: string
    }
    const target = String(body.collection ?? '')
    if (!isIdent(target) || /^directus_/i.test(target))
      return reply.code(400).send({ error: 'Invalid collection' })
    const steps = (Array.isArray(body.steps) ? body.steps : []).slice(0, 6).map((s, i) => ({
      key: typeof s?.key === 'string' ? s.key.slice(0, 40) : `step${i}`,
      label: typeof s?.label === 'string' ? s.label.slice(0, 120) : `Step ${i + 1}`,
      filter: isFilter(s?.filter) ? s.filter : null
    }))
    const fields = Array.isArray(body.fields)
      ? body.fields.filter((f) => typeof f === 'string' && /^[A-Za-z_][\w.]*$/.test(f)).slice(0, 12)
      : []
    const sort =
      typeof body.sort === 'string' && body.sort.trim()
        ? body.sort
            .split(',')
            .map((s) => s.trim())
            .filter((s) => /^-?[A-Za-z_][\w.]*$/.test(s))
        : undefined
    const user = req.user!
    const count = async (filter: Record<string, unknown> | undefined, picker: boolean) =>
      Number(
        (
          (await readItems(
            user,
            target,
            { fields: ['id'], limit: 1, ...(filter ? { filter } : {}) },
            fakeReq(picker)
          )) as { total?: number }
        ).total ?? 0
      )
    try {
      return await withReadGate(
        user.id,
        async () => {
          const total = await count(undefined, false)
          const parts: Record<string, unknown>[] = []
          const counted: Array<{ key: string; label: string; count: number; applies: boolean }> = []
          for (const s of steps) {
            if (s.filter) parts.push(s.filter)
            counted.push({
              key: s.key,
              label: s.label,
              count: s.filter ? await count(and(parts), false) : -1,
              applies: !!s.filter
            })
          }
          const filter = and(parts)
          const offered = await count(filter, true)
          const colRow = (await db('nivaro_collections')
            .where({ collection: target })
            .first('picker_filter')) as { picker_filter?: string | null } | undefined
          let pickerFilter: Record<string, unknown> | null = null
          try {
            const raw = colRow?.picker_filter
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
            pickerFilter = isFilter(parsed) ? parsed : null
          } catch {
            pickerFilter = null
          }
          const withPickerFilter = pickerFilter
            ? await count(and([...parts, pickerFilter]), true)
            : null
          const rows = (
            (await readItems(
              user,
              target,
              {
                limit: 50,
                count: false,
                ...(fields.length ? { fields: ['id', ...fields] } : {}),
                ...(filter ? { filter } : {}),
                ...(sort?.length ? { sort } : {})
              },
              fakeReq(true)
            )) as { data?: Array<Record<string, unknown>> }
          ).data
          return reply.send({
            data: {
              total,
              steps: counted,
              excluded: Math.max(
                0,
                (counted.filter((c) => c.applies).slice(-1)[0]?.count ?? total) - offered
              ),
              offered,
              picker_filter: pickerFilter,
              with_picker_filter: withPickerFilter,
              rows: rows ?? []
            }
          })
        },
        { label: `layout-inspect:picker:${target}` }
      )
    } catch (err) {
      const e = err as { statusCode?: number; message?: string }
      const status = e.statusCode && e.statusCode < 500 ? e.statusCode : 400
      return reply.code(status).send({ error: e.message || 'The options could not be read' })
    }
  })
}

/** A placement's overrides as an object (stored JSON text or parsed). */
function readI18nOverrides(v: unknown): Record<string, unknown> {
  let raw = v
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}
