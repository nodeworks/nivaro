/**
 * Layout inspector reads (#2634 #2636 #2638 #2650 #2665): what the layout
 * editor's inspector, add panel and overview ask the database about a
 * collection's forms. Admin-only, read-only, never a write — removals go
 * through POST /collection-layouts/:id/ops like every other layout change.
 */

import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import { rawRows } from '../db/raw-rows.js'

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
export const isIdent = (v: unknown): v is string => typeof v === 'string' && IDENT.test(v)

/** Width checks read at most this many stored values (newest first). */
export const WIDTH_SAMPLE_CAP = 5000

// ─── Column facts (#2636) ────────────────────────────────────────────────────

export interface ColumnFact {
  /** The database type as the driver reports it: nvarchar, int, decimal… */
  type: string
  /** Characters a text column holds; null = unbounded (max) or not text. */
  max_length: number | null
  /** Digits / scale for exact numerics; null otherwise. */
  precision: number | null
  scale: number | null
  nullable: boolean
}

/** Every column of `table` with its type and size. information_schema reads are
 *  cached at the driver seam, so this costs nothing after the first call. */
export async function columnFacts(table: string): Promise<Record<string, ColumnFact>> {
  if (!isIdent(table)) return {}
  const info = (await db(table).columnInfo()) as Record<
    string,
    { type: string; maxLength: number | string | null; nullable: boolean }
  >
  const out: Record<string, ColumnFact> = {}
  for (const [name, c] of Object.entries(info)) {
    const len = c.maxLength == null ? null : Number(c.maxLength)
    out[name] = {
      type: String(c.type ?? '').toLowerCase(),
      // -1 = nvarchar(max): no limit worth warning about.
      max_length: len != null && Number.isFinite(len) && len > 0 ? len : null,
      precision: null,
      scale: null,
      nullable: !!c.nullable
    }
  }
  if (isMssql(db)) {
    try {
      const rows = rawRows<{ name: string; p: number | null; s: number | null }>(
        await db.raw(
          `SELECT COLUMN_NAME AS name, NUMERIC_PRECISION AS p, NUMERIC_SCALE AS s
             FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_NAME = ? AND DATA_TYPE IN ('decimal','numeric')`,
          [table]
        )
      )
      for (const r of rows) {
        const f = out[r.name]
        if (!f) continue
        f.precision = r.p == null ? null : Number(r.p)
        f.scale = r.s == null ? null : Number(r.s)
      }
    } catch {
      // precision is a nicety; the type and length still answer
    }
  }
  return out
}

// ─── Value lengths (#2634) ───────────────────────────────────────────────────

export interface LengthStats {
  /** Rows read (newest first, capped). */
  sampled: number
  /** Of those, how many held a value. */
  filled: number
  p50: number
  p95: number
  max: number
  capped: boolean
}

/** Nearest-rank percentile of already sorted ascending numbers. */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

export function lengthStats(lengths: number[], sampled: number, cap: number): LengthStats {
  const sorted = [...lengths].sort((a, b) => a - b)
  return {
    sampled,
    filled: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
    capped: sampled >= cap
  }
}

/** Character lengths of the newest `cap` stored values of `field` — TOP N by
 *  the primary key, never a scan of the whole table. */
export async function sampleValueLengths(
  table: string,
  field: string,
  hasId: boolean,
  cap = WIDTH_SAMPLE_CAP
): Promise<LengthStats> {
  const n = Math.max(1, Math.min(WIDTH_SAMPLE_CAP, Math.floor(cap)))
  let rows: Array<{ n: number | string | null }>
  if (isMssql(db)) {
    const order = hasId ? 'ORDER BY [id] DESC' : ''
    rows = rawRows<{ n: number | null }>(
      await db.raw(`SELECT TOP (${n}) LEN(CAST(?? AS nvarchar(max))) AS n FROM ?? ${order}`, [
        field,
        table
      ])
    )
  } else {
    const q = db(table)
      .select(db.raw('LENGTH(CAST(?? AS TEXT)) AS n', [field]))
      .limit(n)
    if (hasId) q.orderBy('id', 'desc')
    rows = (await q) as Array<{ n: number | null }>
  }
  const lengths = rows
    .map((r) => (r.n == null ? null : Number(r.n)))
    .filter((v): v is number => v != null && Number.isFinite(v) && v > 0)
  return lengthStats(lengths, rows.length, n)
}

// ─── Orphaned placements (#2650) ─────────────────────────────────────────────

export interface InspectPlacement {
  field: string
  group_key: string | null
  widget_id?: number | null
}

export interface InspectRelation {
  many_collection: string
  many_field: string
  one_collection: string | null
  one_field: string | null
  junction_field: string | null
}

export type OrphanReason = 'column_dropped' | 'widget_deleted' | 'grid_missing' | 'section_missing'

export interface OrphanContext {
  collection: string
  /** Lower-cased column names per table that exists (missing table = absent key). */
  columns: Map<string, Set<string>>
  /** nivaro_fields rows with no column that still render (computed, virtual). */
  virtualFields: Set<string>
  relations: InspectRelation[]
  widgetIds: Set<number>
  /** Group keys this layout (and its parent) defines. */
  groupKeys: Set<string>
  /** nivaro_fields rows that declare a relation alias (o2m, m2m, files…). */
  aliasFields?: Set<string>
}

const SPECIAL_GROUPS = new Set([
  '__header__',
  '__ungrouped__',
  '__apply_values__',
  '__create_with_defaults__'
])

const hasCol = (ctx: OrphanContext, table: string | null | undefined, col: string | null) =>
  !!table && !!col && !!ctx.columns.get(table)?.has(col.toLowerCase())

/** One hop of a relation path, read the way field-config's classifyRelationSegment
 *  reads it: many-to-one, many-to-many or one-to-many. null = no such link. */
export function hopOf(
  relations: InspectRelation[],
  from: string,
  seg: string
): { next: string; tables: Array<[string, string]> } | null {
  const m2o = relations.find(
    (r) =>
      r.many_collection === from && r.many_field === seg && !r.junction_field && r.one_collection
  )
  if (m2o) return { next: m2o.one_collection as string, tables: [[from, seg]] }
  const m2m = relations.find(
    (r) => r.one_collection === from && r.one_field === seg && r.junction_field && r.many_collection
  )
  if (m2m) {
    const target = relations.find(
      (r) =>
        r.many_collection === m2m.many_collection &&
        r.many_field === m2m.junction_field &&
        r.one_collection
    )
    if (target?.one_collection)
      return {
        next: target.one_collection,
        tables: [
          [m2m.many_collection, m2m.many_field],
          [m2m.many_collection, m2m.junction_field as string]
        ]
      }
  }
  const o2m = relations.find(
    (r) =>
      r.one_collection === from && r.one_field === seg && !r.junction_field && r.many_collection
  )
  if (o2m) return { next: o2m.many_collection, tables: [[o2m.many_collection, o2m.many_field]] }
  return null
}

/** A relation-path placement ('order.customer.name'): every hop a link whose
 *  table and key column exist, ending on a column of the last table. */
function pathOk(ctx: OrphanContext, path: string): boolean {
  const segs = path.split('.')
  let cur = ctx.collection
  for (let i = 0; i < segs.length - 1; i++) {
    const hop = hopOf(ctx.relations, cur, segs[i])
    if (!hop || !ctx.columns.has(hop.next)) return false
    if (!hop.tables.every(([t, c]) => hasCol(ctx, t, c))) return false
    cur = hop.next
  }
  // The last segment is a column, or a link the path shows as a list.
  const last = segs[segs.length - 1]
  if (hasCol(ctx, cur, last)) return true
  const end = hopOf(ctx.relations, cur, last)
  return !!end && end.tables.every(([t, c]) => hasCol(ctx, t, c))
}

/** Why a placement points at nothing, or null when it still resolves. Relations
 *  are a claim, not truth: an alias counts only when its table and column exist. */
export function orphanReason(p: InspectPlacement, ctx: OrphanContext): OrphanReason | null {
  const f = p.field
  if (/^__widget_\d+__$/.test(f) || p.widget_id != null) {
    const id = p.widget_id ?? Number(f.slice('__widget_'.length, -2))
    return ctx.widgetIds.has(Number(id)) ? null : 'widget_deleted'
  }
  if (f.startsWith('__')) return null // slot cards, the subtitle, extension panels
  if (p.group_key != null && !SPECIAL_GROUPS.has(p.group_key) && !ctx.groupKeys.has(p.group_key))
    return 'section_missing'
  if (f.includes('.')) return pathOk(ctx, f) ? null : 'column_dropped'
  if (hasCol(ctx, ctx.collection, f) || ctx.virtualFields.has(f)) return null
  // A one-to-many / many-to-many alias, matched as the record form matches it:
  // by the relation's one_field or by the related table's name.
  const alias = ctx.relations.find(
    (r) => r.one_collection === ctx.collection && (r.one_field === f || r.many_collection === f)
  )
  if (alias) {
    if (!hasCol(ctx, alias.many_collection, alias.many_field)) return 'grid_missing'
    if (alias.junction_field && !hasCol(ctx, alias.many_collection, alias.junction_field))
      return 'grid_missing'
    return null
  }
  return ctx.aliasFields?.has(f) ? 'grid_missing' : 'column_dropped'
}

export const ORPHAN_WORDS: Record<OrphanReason, string> = {
  column_dropped: 'its column no longer exists',
  widget_deleted: 'the widget was deleted',
  grid_missing: "the grid's table or link column no longer exists",
  section_missing: 'it sits in a section that no longer exists'
}

export interface OrphanLayout {
  layout_id: number
  name: string
  layout_type: string
  placements: Array<{ field: string; group_key: string | null; reason: OrphanReason }>
}

async function existingColumns(tables: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  for (const t of [...new Set(tables)].filter(isIdent)) {
    try {
      if (!(await db.schema.hasTable(t))) continue
      const facts = await columnFacts(t)
      out.set(t, new Set(Object.keys(facts).map((c) => c.toLowerCase())))
    } catch {
      // unreadable table = treat as missing
    }
  }
  return out
}

/** Every layout of `collection` with the placements that point at nothing. */
export async function findOrphanPlacements(collection: string): Promise<OrphanLayout[]> {
  const layouts = (await db('nivaro_collection_layouts')
    .where({ collection })
    .orderBy([{ column: 'sort' }, { column: 'id' }])
    .select('id', 'name', 'layout_type', 'parent_layout_id')) as Array<{
    id: number
    name: string
    layout_type: string | null
    parent_layout_id: number | null
  }>
  if (!layouts.length) return []
  const ids = layouts.map((l) => Number(l.id))
  const parentIds = layouts
    .map((l) => (l.parent_layout_id == null ? null : Number(l.parent_layout_id)))
    .filter((v): v is number => v != null)
  const [assignments, groups, relations, fieldRows, widgets] = await Promise.all([
    db('nivaro_layout_field_assignments')
      .whereIn('layout_id', ids)
      .select('layout_id', 'field', 'group_key', 'widget_id') as Promise<
      Array<InspectPlacement & { layout_id: number }>
    >,
    db('nivaro_field_groups')
      .whereIn('layout_id', [...new Set([...ids, ...parentIds])])
      .select('layout_id', 'key') as Promise<Array<{ layout_id: number; key: string }>>,
    db('nivaro_relations')
      .where((q) =>
        q.where({ many_collection: collection }).orWhere({ one_collection: collection })
      )
      .select(
        'many_collection',
        'many_field',
        'one_collection',
        'one_field',
        'junction_field'
      ) as Promise<InspectRelation[]>,
    db('nivaro_fields')
      .where({ collection })
      .select('field', 'type', 'special', 'computed_formula') as Promise<
      Array<{
        field: string
        type: string | null
        special: string | null
        computed_formula: string | null
      }>
    >,
    db('nivaro_widgets').select('id') as Promise<Array<{ id: number }>>
  ])
  // Relation paths hop through other tables: load every relation, walk the hops.
  const paths = [...new Set(assignments.map((a) => a.field).filter((f) => f.includes('.')))]
  const allRelations = paths.length
    ? ((await db('nivaro_relations').select(
        'many_collection',
        'many_field',
        'one_collection',
        'one_field',
        'junction_field'
      )) as InspectRelation[])
    : relations
  const tables = [collection, ...relations.map((r) => r.many_collection)]
  for (const path of paths) {
    let cur = collection
    for (const seg of path.split('.')) {
      const hop = hopOf(allRelations, cur, seg)
      if (!hop) break
      tables.push(hop.next, ...hop.tables.map(([t]) => t))
      cur = hop.next
    }
  }
  const columns = await existingColumns(tables)
  const own = columns.get(collection) ?? new Set<string>()
  const virtualFields = new Set(
    fieldRows
      .filter((f) => f.computed_formula && !own.has(f.field.toLowerCase()))
      .map((f) => f.field)
  )
  const widgetIds = new Set(widgets.map((w) => Number(w.id)))
  const aliasFields = new Set(
    fieldRows
      .filter((f) => f.type === 'alias' || /o2m|m2m|m2a|files/.test(String(f.special ?? '')))
      .map((f) => f.field)
  )

  return layouts.map((l) => {
    const keys = new Set(
      groups
        .filter(
          (g) =>
            Number(g.layout_id) === Number(l.id) ||
            (l.parent_layout_id != null && Number(g.layout_id) === Number(l.parent_layout_id))
        )
        .map((g) => g.key)
    )
    const ctx: OrphanContext = {
      collection,
      columns,
      virtualFields,
      relations: allRelations,
      widgetIds,
      groupKeys: keys,
      aliasFields
    }
    const placements = assignments
      .filter((a) => Number(a.layout_id) === Number(l.id) && a.field !== '__ungrouped_pos__')
      .map((a) => ({
        field: a.field,
        group_key: a.group_key ?? null,
        reason: orphanReason(a, ctx)
      }))
      .filter(
        (a): a is { field: string; group_key: string | null; reason: OrphanReason } => !!a.reason
      )
    return {
      layout_id: Number(l.id),
      name: l.name,
      layout_type: l.layout_type || 'grouped',
      placements
    }
  })
}

// ─── Fields on the collection's other forms (#2638) ──────────────────────────

export interface FormFields {
  layout_id: number
  name: string
  layout_type: string
  fields: string[]
}

/** Each layout of `collection` with the plain fields it places (no slots). */
export async function formFields(collection: string): Promise<FormFields[]> {
  const layouts = (await db('nivaro_collection_layouts')
    .where({ collection })
    .select('id', 'name', 'layout_type')) as Array<{
    id: number
    name: string
    layout_type: string | null
  }>
  if (!layouts.length) return []
  const rows = (await db('nivaro_layout_field_assignments')
    .whereIn(
      'layout_id',
      layouts.map((l) => Number(l.id))
    )
    .select('layout_id', 'field')) as Array<{ layout_id: number; field: string }>
  return layouts.map((l) => ({
    layout_id: Number(l.id),
    name: l.name,
    layout_type: l.layout_type || 'grouped',
    fields: [
      ...new Set(
        rows
          .filter((r) => Number(r.layout_id) === Number(l.id) && !r.field.startsWith('__'))
          .map((r) => r.field)
      )
    ]
  }))
}

// ─── Layout text translations (#2665) ────────────────────────────────────────

let i18nColumn: { at: number; ok: boolean } | null = null

/** Whether nivaro_field_groups has the `i18n` column (migration 465). A yes is
 *  kept for the process; a no is asked again after a minute (the migration
 *  may run while this process lives). */
export async function groupI18nSupported(): Promise<boolean> {
  if (i18nColumn && (i18nColumn.ok || Date.now() - i18nColumn.at < 60_000)) return i18nColumn.ok
  let ok = false
  try {
    ok = await db.schema.hasColumn('nivaro_field_groups', 'i18n')
  } catch {
    ok = false
  }
  i18nColumn = { at: Date.now(), ok }
  return ok
}

export type I18nMap = Record<string, Record<string, string>>

/** `{ es: { label: 'Nombre', note: '…' } }` from a placement's overrides or a
 *  group's i18n text; anything malformed reads as no translations. */
export function readI18n(v: unknown): I18nMap {
  let raw = v
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: I18nMap = {}
  for (const [loc, texts] of Object.entries(raw as Record<string, unknown>)) {
    if (!texts || typeof texts !== 'object' || Array.isArray(texts)) continue
    const t: Record<string, string> = {}
    for (const [k, s] of Object.entries(texts as Record<string, unknown>))
      if (typeof s === 'string' && s.trim()) t[k] = s
    if (Object.keys(t).length) out[loc] = t
  }
  return out
}

export interface TranslatableText {
  /** The texts a translation is expected for: label, and note when the base has help. */
  keys: string[]
  i18n: I18nMap
}

/** Missing translations: one per (text, key, locale) with no translated string. */
export function countMissing(
  texts: TranslatableText[],
  locales: string[]
): { missing: number; total: number } {
  let missing = 0
  let total = 0
  for (const t of texts)
    for (const k of t.keys)
      for (const loc of locales) {
        total++
        if (!t.i18n[loc]?.[k]) missing++
      }
  return { missing, total }
}

/** The locales layout text is translated into: available_locales minus the
 *  first, which is the language the labels are written in. */
export async function translationLocales(): Promise<{ base: string; others: string[] }> {
  let list: string[] = ['en']
  try {
    const row = (await db('nivaro_settings').first('available_locales')) as
      | { available_locales?: unknown }
      | undefined
    const raw = row?.available_locales
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (Array.isArray(parsed) && parsed.length)
      list = parsed.map(String).filter((s) => /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(s))
  } catch {
    // unreadable setting: no other languages
  }
  return { base: list[0] ?? 'en', others: list.slice(1) }
}
