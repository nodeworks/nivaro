import type { FastifyBaseLogger } from 'fastify'
import type { Knex } from 'knex'
import { getCollection } from './collections.js'
import { resolveDisplayValue } from './display-value.js'

// ─── Review list widget (generic grouped-review form slot) ─────────────────
//
// Generalizes the legacy EFP "Invoice Approvals" slot: rows of a target
// collection reached from a host record via a relation path, grouped with a
// sum aggregate, with per-group status actions. This module owns the config
// validation (widget create/PATCH) and the reverse path walk + row
// resolution (widget render). See
// docs/superpowers/specs/2026-07-19-review-list-widget-design.md.

export type Logger = Pick<FastifyBaseLogger, 'warn'>

// Mirrors the logger fallback idiom in transition-requirements.ts — callers
// without a Fastify request logger (tests, future non-request callers) fall
// back to console rather than requiring a logger everywhere.
export const consoleLogger: Logger = {
  warn: ((...args: unknown[]) => {
    console.warn(...args)
  }) as unknown as Logger['warn']
}

export const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

const MAX_PATH_HOPS = 4
export const CAP = 2000

// 'flag' renders a colored pill bearing the column label when the value is
// truthy (and nothing when falsy) — for boolean badges like "On Hold".
export const COLUMN_FORMATS = ['currency', 'number', 'date', 'datetime', 'flag'] as const
export type ColumnFormat = (typeof COLUMN_FORMATS)[number]

/** Object form of a group_meta / line_columns entry. Plain strings remain valid. */
export interface ColumnSpec {
  field: string
  label?: string
  format?: ColumnFormat
  /** Pill color for format 'flag' (same palette as status option colors). */
  color?: string
}

/** Minimal shape shared by any widget config that walks a relation path from
 * a host record to a target collection (review_list, rollup, ...). */
export interface PathWalkConfig {
  host_collection: string
  collection: string
  path: Array<{ kind: 'm2o' | 'm2m'; field: string }>
}

export interface ReviewListConfig extends PathWalkConfig {
  static_filter?: Array<{ field: string; op: 'eq' | 'neq' | 'nnull'; value?: unknown }>
  group_by: string
  aggregate_sum?: string | null
  aggregate_sum_format?: ColumnFormat | null
  group_meta?: Array<string | ColumnSpec>
  line_columns?: Array<string | ColumnSpec>
  status: {
    field: string
    options: Array<{ value: string; label: string; color: string }>
    /** Badge shown when the status value is empty (e.g. "Unreviewed"). */
    empty_label?: string | null
    empty_color?: string | null
    stamp_user_field?: string | null
    stamp_date_field?: string | null
  }
}

/** nivaro_relations row shape (caller fetches; duplicated locally per brief). */
export interface RelRow {
  many_collection: string
  many_field: string
  one_collection: string | null
  one_field: string | null
  junction_field: string | null
}

export interface ReviewListRow {
  id: string | number
  group: unknown
  values: Record<string, unknown>
  status: unknown
  stamp_user: { id: string; label: string } | null
  stamp_date: string | null
}

export interface ReviewListResult {
  rows: ReviewListRow[]
  columns: {
    group_meta: Array<{
      field: string
      label: string
      format: ColumnFormat | null
      color: string | null
    }>
    line_columns: Array<{
      field: string
      label: string
      format: ColumnFormat | null
      color: string | null
    }>
  }
  truncated: boolean
}

/** Collapse the string | ColumnSpec union to ColumnSpec (validated by this point). */
export function normalizeColumnSpecs(
  entries: Array<string | ColumnSpec> | undefined
): ColumnSpec[] {
  return (entries ?? []).map((e) => (typeof e === 'string' ? { field: e } : e))
}

// ─── Relation resolution ────────────────────────────────────────────────────
//
// Both directions (config-validation's forward walk target→host, and the
// render-time reverse walk host→target) resolve the same relation rows —
// just anchored from opposite ends of the hop. `opts.many`/`opts.one` (m2o)
// and `opts.owner`/`opts.related` (m2m) let each caller supply whichever end
// it already knows and solve for the other.

export function findM2oRelation(
  relations: RelRow[],
  field: string,
  opts: { many?: string; one?: string }
): RelRow | undefined {
  return relations.find(
    (r) =>
      r.many_field === field &&
      r.junction_field == null &&
      (opts.many === undefined || r.many_collection === opts.many) &&
      (opts.one === undefined || r.one_collection === opts.one)
  )
}

interface M2mAliasResolution {
  aliasCollection: string
  relatedCollection: string
  junction: string
  fkToOwner: string
  fkToRelated: string
}

// M2M alias fields aren't real columns — they're identified by a relation row
// with junction_field set (one_collection = the collection the alias lives
// on, one_field = the alias name, junction_field = the junction's OTHER fk
// column). Same fallback policy as transition-requirements.ts's m2mByField
// resolution: match by one_field first, fall back to the junction table's
// own name as the alias field.
export function findM2mAlias(
  relations: RelRow[],
  field: string,
  opts: { owner?: string; related?: string }
): M2mAliasResolution | undefined {
  const candidates = relations.filter(
    (r) => r.junction_field != null && (r.one_field === field || r.many_collection === field)
  )
  for (const alias of candidates) {
    if (!alias.one_collection || !alias.junction_field) continue
    if (opts.owner !== undefined && alias.one_collection !== opts.owner) continue
    const companion = relations.find(
      (r) => r.many_collection === alias.many_collection && r.many_field === alias.junction_field
    )
    if (!companion?.one_collection) continue
    if (opts.related !== undefined && companion.one_collection !== opts.related) continue
    return {
      aliasCollection: alias.one_collection,
      relatedCollection: companion.one_collection,
      junction: alias.many_collection,
      fkToOwner: alias.many_field,
      fkToRelated: alias.junction_field
    }
  }
  return undefined
}

// ─── Config validation (widget create/PATCH) ───────────────────────────────

export function isPlainIdentifier(v: unknown): v is string {
  return typeof v === 'string' && IDENTIFIER_RE.test(v)
}

// group_meta / line_columns allow ONE dot-path hop (`purchase_order.number`) —
// at most one '.', every segment a valid identifier.
export function isDotPathIdentifier(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const parts = v.split('.')
  if (parts.length > 2) return false
  return parts.every((p) => IDENTIFIER_RE.test(p))
}

export function validateReviewListConfig(raw: unknown, relations: RelRow[]): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'config must be an object'
  const c = raw as Record<string, unknown>

  if (!isPlainIdentifier(c.host_collection)) return 'host_collection must be a valid identifier'
  if (!isPlainIdentifier(c.collection)) return 'collection must be a valid identifier'

  if (!Array.isArray(c.path) || c.path.length === 0 || c.path.length > MAX_PATH_HOPS) {
    return `path must be a non-empty array of at most ${MAX_PATH_HOPS} hops`
  }
  const path: Array<{ kind: 'm2o' | 'm2m'; field: string }> = []
  for (let i = 0; i < c.path.length; i++) {
    const hop = c.path[i]
    if (!hop || typeof hop !== 'object' || Array.isArray(hop)) return `path[${i}] must be an object`
    const h = hop as Record<string, unknown>
    if (h.kind !== 'm2o' && h.kind !== 'm2m') return `path[${i}].kind must be 'm2o' or 'm2m'`
    if (!isPlainIdentifier(h.field)) return `path[${i}].field must be a valid identifier`
    path.push({ kind: h.kind, field: h.field })
  }

  // Forward walk (target → host): the path must resolve hop-by-hop against
  // nivaro_relations and land exactly on host_collection.
  let cur = c.collection as string
  for (let i = 0; i < path.length; i++) {
    const hop = path[i]
    if (hop.kind === 'm2o') {
      const rel = findM2oRelation(relations, hop.field, { many: cur })
      if (!rel?.one_collection) return `path[${i}] (${hop.field}) does not resolve from ${cur}`
      cur = rel.one_collection
    } else {
      const alias = findM2mAlias(relations, hop.field, { owner: cur })
      if (!alias) return `path[${i}] (${hop.field}) does not resolve from ${cur}`
      cur = alias.relatedCollection
    }
  }
  if (cur !== c.host_collection) return 'path does not terminate at host_collection'

  if (c.static_filter !== undefined) {
    if (!Array.isArray(c.static_filter)) return 'static_filter must be an array'
    for (let i = 0; i < c.static_filter.length; i++) {
      const f = c.static_filter[i]
      if (!f || typeof f !== 'object' || Array.isArray(f))
        return `static_filter[${i}] must be an object`
      const ff = f as Record<string, unknown>
      if (!isPlainIdentifier(ff.field))
        return `static_filter[${i}].field must be a valid identifier`
      if (ff.op !== 'eq' && ff.op !== 'neq' && ff.op !== 'nnull') {
        return `static_filter[${i}].op must be eq, neq, or nnull`
      }
      if (ff.op !== 'nnull' && ff.value === undefined) {
        return `static_filter[${i}].value is required for op "${ff.op}"`
      }
    }
  }

  if (!isPlainIdentifier(c.group_by)) return 'group_by must be a valid identifier'

  if (
    c.aggregate_sum !== undefined &&
    c.aggregate_sum !== null &&
    !isPlainIdentifier(c.aggregate_sum)
  ) {
    return 'aggregate_sum must be a valid identifier'
  }
  if (
    c.aggregate_sum_format !== undefined &&
    c.aggregate_sum_format !== null &&
    !COLUMN_FORMATS.includes(c.aggregate_sum_format as ColumnFormat)
  ) {
    return `aggregate_sum_format must be one of: ${COLUMN_FORMATS.join(', ')}`
  }

  const columnSpecError = (key: 'group_meta' | 'line_columns'): string | null => {
    const entries = c[key]
    if (entries === undefined) return null
    if (!Array.isArray(entries)) return `${key} must be an array`
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (typeof e === 'string') {
        if (!isDotPathIdentifier(e))
          return `${key}[${i}] must be a valid field name (one dot-path hop max)`
        continue
      }
      if (!e || typeof e !== 'object' || Array.isArray(e)) {
        return `${key}[${i}] must be a field name or an object`
      }
      const spec = e as Record<string, unknown>
      if (!isDotPathIdentifier(spec.field))
        return `${key}[${i}].field must be a valid field name (one dot-path hop max)`
      if (spec.label !== undefined && (typeof spec.label !== 'string' || !spec.label)) {
        return `${key}[${i}].label must be a non-empty string`
      }
      if (spec.format !== undefined && !COLUMN_FORMATS.includes(spec.format as ColumnFormat)) {
        return `${key}[${i}].format must be one of: ${COLUMN_FORMATS.join(', ')}`
      }
      if (spec.color !== undefined && (typeof spec.color !== 'string' || !spec.color)) {
        return `${key}[${i}].color must be a non-empty string`
      }
    }
    return null
  }
  const metaError = columnSpecError('group_meta')
  if (metaError) return metaError
  const lineError = columnSpecError('line_columns')
  if (lineError) return lineError

  if (!c.status || typeof c.status !== 'object' || Array.isArray(c.status))
    return 'status must be an object'
  const status = c.status as Record<string, unknown>
  if (!isPlainIdentifier(status.field)) return 'status.field must be a valid identifier'
  if (!Array.isArray(status.options) || status.options.length === 0) {
    return 'status.options must be a non-empty array'
  }
  if (
    status.empty_label !== undefined &&
    status.empty_label !== null &&
    (typeof status.empty_label !== 'string' || !status.empty_label)
  ) {
    return 'status.empty_label must be a non-empty string'
  }
  if (
    status.empty_color !== undefined &&
    status.empty_color !== null &&
    (typeof status.empty_color !== 'string' || !status.empty_color)
  ) {
    return 'status.empty_color must be a non-empty string'
  }
  const seenValues = new Set<string>()
  for (let i = 0; i < status.options.length; i++) {
    const opt = status.options[i]
    if (!opt || typeof opt !== 'object' || Array.isArray(opt))
      return `status.options[${i}] must be an object`
    const o = opt as Record<string, unknown>
    if (typeof o.value !== 'string' || !o.value)
      return `status.options[${i}].value must be a non-empty string`
    if (typeof o.label !== 'string' || !o.label)
      return `status.options[${i}].label must be a non-empty string`
    if (typeof o.color !== 'string' || !o.color)
      return `status.options[${i}].color must be a non-empty string`
    if (seenValues.has(o.value)) return `status.options[${i}].value is a duplicate`
    seenValues.add(o.value)
  }
  if (
    status.stamp_user_field !== undefined &&
    status.stamp_user_field !== null &&
    !isPlainIdentifier(status.stamp_user_field)
  ) {
    return 'status.stamp_user_field must be a valid identifier'
  }
  if (
    status.stamp_date_field !== undefined &&
    status.stamp_date_field !== null &&
    !isPlainIdentifier(status.stamp_date_field)
  ) {
    return 'status.stamp_date_field must be a valid identifier'
  }

  return null
}

// ─── Render-time reverse path walk + row resolution ────────────────────────

export function badConfig(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400 })
}

export function hopError(field: string, logPrefix = 'review_list'): never {
  throw Object.assign(new Error(`${logPrefix}: no relation found for path hop "${field}"`), {
    statusCode: 400
  })
}

// The reverse walk (below) must anchor each hop by BOTH ends of the relation
// — the collection the field lives on AND the related collection — or an
// ambiguous relation name (two collections with the same FK field name to
// the same target) can resolve to the wrong table. The forward walk (target
// → host, used by the validator) already anchors deterministically by the
// collection the field lives on; recompute that same chain here so the
// reverse walk can borrow its "owning collection" per hop as the second
// anchor. Config is validated by this point, so this mirrors a walk that is
// guaranteed to succeed — the hopError fallback exists only for defense.
export function computeForwardChain(
  config: PathWalkConfig,
  relations: RelRow[],
  logPrefix = 'review_list'
): string[] {
  const owners: string[] = []
  let cur = config.collection
  for (const hop of config.path) {
    owners.push(cur)
    if (hop.kind === 'm2o') {
      const rel = findM2oRelation(relations, hop.field, { many: cur })
      if (!rel?.one_collection) hopError(hop.field, logPrefix)
      cur = rel.one_collection
    } else {
      const alias = findM2mAlias(relations, hop.field, { owner: cur })
      if (!alias) hopError(hop.field, logPrefix)
      cur = alias.relatedCollection
    }
  }
  return owners
}

export function dedupIds(values: unknown[]): string[] {
  return [...new Set(values.filter((v) => v != null).map(String))]
}

export interface DotSpec {
  raw: string
  fkField: string
  subField: string
}

export function splitDotSpecs(specs: string[]): DotSpec[] {
  const dot: DotSpec[] = []
  for (const s of specs) {
    const parts = s.split('.')
    if (parts.length === 2) dot.push({ raw: s, fkField: parts[0], subField: parts[1] })
  }
  return dot
}

// Reverse walk (host → target): process path hops from LAST to FIRST, each
// hop resolving "ids of the next collection outward related to the current
// id set." Anchors every hop at BOTH ends of the relation (the owning
// collection from the deterministic forward chain, and the current
// collection) — see the C1 test in review-list.test.ts for why a single-end
// anchor is unsafe when two collections share an FK field name to the same
// target. Shared by review_list and rollup (both walk host → target the same
// way); logPrefix keys the 400/warn messages to the calling widget type.
export async function walkReversePath(
  database: Knex,
  config: PathWalkConfig,
  relations: RelRow[],
  recordId: string,
  logger: Logger = consoleLogger,
  logPrefix = 'review_list'
): Promise<{ idSet: string[]; truncated: boolean }> {
  let currentCollection = config.host_collection
  let idSet: string[] = [recordId]
  let truncated = false

  const hopOwners = computeForwardChain(config, relations, logPrefix)

  for (let i = config.path.length - 1; i >= 0; i--) {
    const hop = config.path[i]
    const owner = hopOwners[i]

    if (hop.kind === 'm2m') {
      const alias = findM2mAlias(relations, hop.field, { owner, related: currentCollection })
      if (!alias) hopError(hop.field, logPrefix)
      if (idSet.length > 0) {
        const junctionRows = (await database(alias.junction)
          .whereIn(alias.fkToRelated, idSet)
          .limit(CAP)
          .select(alias.fkToOwner)) as Array<Record<string, unknown>>
        if (junctionRows.length === CAP) {
          truncated = true
          logger.warn(
            { junction: alias.junction, hop: hop.field },
            `${logPrefix}: hop query truncated at cap`
          )
        }
        idSet = dedupIds(junctionRows.map((r) => r[alias.fkToOwner]))
      }
      currentCollection = alias.aliasCollection
    } else {
      const rel = findM2oRelation(relations, hop.field, { many: owner, one: currentCollection })
      if (!rel) hopError(hop.field, logPrefix)
      if (idSet.length > 0) {
        const rows = (await database(rel.many_collection)
          .whereIn(hop.field, idSet)
          .limit(CAP)
          .select('id')) as Array<{ id: unknown }>
        if (rows.length === CAP) {
          truncated = true
          logger.warn(
            { collection: rel.many_collection, hop: hop.field },
            `${logPrefix}: hop query truncated at cap`
          )
        }
        idSet = dedupIds(rows.map((r) => r.id))
      }
      currentCollection = rel.many_collection
    }
  }

  return { idSet, truncated }
}

// Dot-path resolution: batched IN query per FK field, mirroring the batched
// related-label approach in transition-requirements.ts's relatedLabel helper
// — but resolving a NAMED sub-field, not a display template. Dead relation
// degrades to the raw fk value (display polish must never crash the render).
// Shared by review_list (group_meta/line_columns) and rollup (levels/
// leaf_columns/measure sum+filter fields) — same one-hop dot-path semantics.
export async function resolveDotSpecValues(
  database: Knex,
  collection: string,
  relations: RelRow[],
  dotSpecs: DotSpec[],
  targetRows: Array<Record<string, unknown>>,
  logger: Logger = consoleLogger,
  logPrefix = 'review_list'
): Promise<Map<string, Map<string, unknown>>> {
  const dotByFk = new Map<string, Set<string>>()
  for (const d of dotSpecs) {
    const set = dotByFk.get(d.fkField) ?? new Set<string>()
    set.add(d.subField)
    dotByFk.set(d.fkField, set)
  }
  const dotValueMaps = new Map<string, Map<string, unknown>>()
  for (const [fkField, subFields] of dotByFk) {
    const rel = findM2oRelation(relations, fkField, { many: collection })
    if (!rel?.one_collection) {
      logger.warn(
        { collection, field: fkField },
        `${logPrefix}: dot-path relation not found, falling back to raw value`
      )
      continue
    }
    const distinctIds = dedupIds(targetRows.map((r) => r[fkField]))
    if (distinctIds.length === 0) continue
    const subFieldList = [...subFields]
    const related = (await database(rel.one_collection)
      .whereIn('id', distinctIds)
      .limit(500)
      .select(['id', ...subFieldList])) as Array<Record<string, unknown>>
    for (const sub of subFieldList) {
      const m = new Map<string, unknown>()
      for (const r of related) m.set(String(r.id), r[sub] ?? null)
      dotValueMaps.set(`${fkField}.${sub}`, m)
    }
  }
  return dotValueMaps
}

// Batched id → display-label resolution against a related collection's
// display_template (falls back to resolveDisplayValue's own heuristics when
// there's no template). Shared by review_list's stamp_user label and
// rollup's level-label resolution — both are "M2O FK ids on the fetched rows
// → human labels" lookups.
export async function resolveRelatedLabels(
  database: Knex,
  collection: string,
  ids: unknown[]
): Promise<Map<string, string>> {
  const distinctIds = dedupIds(ids)
  if (distinctIds.length === 0) return new Map()
  let template: string | null = null
  try {
    template = (await getCollection(collection))?.display_template ?? null
  } catch {
    template = null
  }
  const rows = (await database(collection)
    .whereIn('id', distinctIds)
    .limit(500)
    .select('*')) as Array<Record<string, unknown>>
  return new Map(rows.map((r) => [String(r.id), resolveDisplayValue(r, template)]))
}

function toIso(v: unknown): string | null {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(v as string)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export async function resolveReviewListRows(
  database: Knex,
  config: ReviewListConfig,
  recordId: string,
  logger: Logger = consoleLogger
): Promise<ReviewListResult> {
  const relations = (await database('nivaro_relations').select(
    'many_collection',
    'many_field',
    'one_collection',
    'one_field',
    'junction_field'
  )) as RelRow[]

  // Stored config can go stale (a relation dropped after save, hand-edited
  // JSON, etc). Re-run the same validator used at write time so read-time
  // config problems 400 cleanly instead of crashing partway through the walk.
  const configError = validateReviewListConfig(config, relations)
  if (configError) badConfig(`review_list: ${configError}`)

  const { idSet, truncated: walkTruncated } = await walkReversePath(
    database,
    config,
    relations,
    recordId,
    logger
  )
  let truncated = walkTruncated

  const groupMetaSpecs = normalizeColumnSpecs(config.group_meta)
  const lineColumnSpecs = normalizeColumnSpecs(config.line_columns)
  const allSpecs = [...new Set([...groupMetaSpecs, ...lineColumnSpecs].map((s) => s.field))]
  const dotSpecs = splitDotSpecs(allSpecs)
  const dotSpecByRaw = new Map(dotSpecs.map((d) => [d.raw, d]))
  const plainSpecs = allSpecs.filter((s) => !dotSpecByRaw.has(s))

  const selectFields = new Set<string>(['id', config.group_by])
  if (config.aggregate_sum) selectFields.add(config.aggregate_sum)
  for (const f of plainSpecs) selectFields.add(f)
  for (const d of dotSpecs) selectFields.add(d.fkField)
  selectFields.add(config.status.field)
  if (config.status.stamp_user_field) selectFields.add(config.status.stamp_user_field)
  if (config.status.stamp_date_field) selectFields.add(config.status.stamp_date_field)

  // Target query: the reverse walk's final id set, ANDed with static_filter.
  let targetRows: Array<Record<string, unknown>> = []
  if (idSet.length > 0) {
    let targetQuery = database(config.collection).whereIn('id', idSet)
    for (const f of config.static_filter ?? []) {
      if (f.op === 'eq') targetQuery = targetQuery.where(f.field, f.value as Knex.Value)
      else if (f.op === 'neq') targetQuery = targetQuery.whereNot(f.field, f.value as Knex.Value)
      else if (f.op === 'nnull') targetQuery = targetQuery.whereNotNull(f.field)
    }
    targetRows = (await targetQuery.limit(CAP).select([...selectFields])) as Array<
      Record<string, unknown>
    >
    if (targetRows.length === CAP) {
      truncated = true
      logger.warn({ collection: config.collection }, 'review_list: target query truncated at cap')
    }
  }

  const dotValueMaps = await resolveDotSpecValues(
    database,
    config.collection,
    relations,
    dotSpecs,
    targetRows,
    logger
  )

  // Stamp-user label resolution (audit tooltip).
  let stampUserLabels: Map<string, string> | null = null
  const stampUserField = config.status.stamp_user_field ?? null
  if (stampUserField) {
    stampUserLabels = await resolveRelatedLabels(
      database,
      'nivaro_users',
      targetRows.map((r) => r[stampUserField])
    )
  }

  const stampDateField = config.status.stamp_date_field ?? null

  const rows: ReviewListRow[] = targetRows.map((row) => {
    const values: Record<string, unknown> = {}
    // aggregate_sum always rides in `values`, even when it isn't also listed
    // in line_columns, so the client can compute the group sum without the
    // caller needing to duplicate the field into line_columns just to fetch it.
    if (config.aggregate_sum) values[config.aggregate_sum] = row[config.aggregate_sum] ?? null
    for (const spec of allSpecs) {
      const dot = dotSpecByRaw.get(spec)
      if (dot) {
        const raw = row[dot.fkField]
        const map = dotValueMaps.get(`${dot.fkField}.${dot.subField}`)
        values[spec] = raw == null ? null : (map?.get(String(raw)) ?? raw)
      } else {
        values[spec] = row[spec] ?? null
      }
    }

    const stampUserRaw = stampUserField ? row[stampUserField] : null
    const stamp_user =
      stampUserRaw != null
        ? {
            id: String(stampUserRaw),
            label: stampUserLabels?.get(String(stampUserRaw)) ?? String(stampUserRaw)
          }
        : null
    const stamp_date = stampDateField ? toIso(row[stampDateField]) : null

    return {
      id: row.id as string | number,
      group: row[config.group_by] ?? null,
      values,
      status: row[config.status.field] ?? null,
      stamp_user,
      stamp_date
    }
  })

  const fieldLabelRows = (await database('nivaro_fields')
    .where({ collection: config.collection })
    .select('field', 'label')) as Array<{ field: string; label: string | null }>
  const labelByField = new Map(fieldLabelRows.map((r) => [r.field, r.label]))
  // Label precedence: config override > nivaro_fields label > raw field name.
  const toColumnMeta = (spec: ColumnSpec) => ({
    field: spec.field,
    label: spec.label || labelByField.get(spec.field) || spec.field,
    format: spec.format ?? null,
    color: spec.color ?? null
  })

  return {
    rows,
    columns: {
      group_meta: groupMetaSpecs.map(toColumnMeta),
      line_columns: lineColumnSpecs.map(toColumnMeta)
    },
    truncated
  }
}
