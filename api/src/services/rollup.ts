import type { Knex } from 'knex'
import {
  badConfig,
  CAP,
  COLUMN_FORMATS,
  type ColumnFormat,
  type ColumnSpec,
  consoleLogger,
  type DotSpec,
  findM2mAlias,
  findM2oRelation,
  isDotPathIdentifier,
  isPlainIdentifier,
  type Logger,
  normalizeColumnSpecs,
  type PathWalkConfig,
  type RelRow,
  resolveDotSpecValues,
  resolveRelatedLabels,
  splitDotSpecs,
  walkReversePath
} from './review-list.js'

// ─── Rollup widget (generic grouped-measure summary) ────────────────────────
//
// Generalizes the legacy EFP "Deployments" cost summary slot
// (efp/src/components/molecules/WorkflowDeployments): rows of a target
// collection reached from a host record via a relation path, grouped by 1-3
// levels client-side, with per-row numeric measures (each with its own
// eq/neq/nnull filter) summed at every level. This module owns config
// validation (widget create/PATCH) and the reverse path walk + row
// resolution (widget render), reusing review-list.ts's shared path-walk,
// dot-path resolution, and related-label helpers verbatim. See
// docs/superpowers/specs/2026-07-20-rollup-widget-lookup-columns-design.md §1.

const MAX_PATH_HOPS = 4
const MAX_LEVELS = 2
const MAX_MEASURES = 4

export const MEASURE_FORMATS = ['currency', 'number'] as const
export type MeasureFormat = (typeof MEASURE_FORMATS)[number]

export interface RollupLevel {
  field: string
  label?: string
}

export interface RollupMeasureFilter {
  field: string
  op: 'eq' | 'neq' | 'nnull'
  value?: unknown
}

export interface RollupMeasure {
  key: string
  label: string
  sum: string
  format?: MeasureFormat
  filter?: RollupMeasureFilter[]
}

export interface RollupConfig extends PathWalkConfig {
  static_filter?: Array<{ field: string; op: 'eq' | 'neq' | 'nnull'; value?: unknown }>
  levels: RollupLevel[]
  leaf_columns?: Array<string | ColumnSpec>
  merge_leaf_by?: string[]
  measures: RollupMeasure[]
  show_totals?: boolean
}

export interface RollupRow {
  id: string | number
  levels: unknown[]
  level_labels: Array<string | null>
  values: Record<string, unknown>
  measures: Record<string, number>
  /** Row reflects client-staged (unsaved) changes. */
  pending?: boolean
}

/** Client-staged (unsaved) target-collection changes merged into the render so
 *  a rollup widget reflects grid edits before the parent record saves.
 *  Created rows may carry literal dotted keys ('workflow_line.deployment_type')
 *  when their parent row is itself unsaved and has no FK id to resolve through. */
export interface RollupStaged {
  created?: Array<Record<string, unknown>>
  updated?: Array<{ id: string | number; values: Record<string, unknown> }>
  deleted?: Array<string | number>
}

export interface RollupResult {
  rows: RollupRow[]
  columns: {
    levels: Array<{ field: string; label: string }>
    leaf_columns: Array<{
      field: string
      label: string
      format: ColumnFormat | null
      color: string | null
    }>
    measures: Array<{ key: string; label: string; format: MeasureFormat | null }>
  }
  truncated: boolean
}

// ─── Config validation (widget create/PATCH) ───────────────────────────────
//
// Mirrors validateReviewListConfig's style and error-message shape; the
// path/static_filter blocks are structurally identical to review_list's
// (same forward-walk termination check against host_collection) but kept
// inline rather than shared, since review-list.ts's validator interleaves
// them with review_list-only fields (group_by, status) that don't apply here.

export function validateRollupConfig(raw: unknown, relations: RelRow[]): string | null {
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

  // Forward walk (target → host): same semantics as review_list.
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

  if (!Array.isArray(c.levels) || c.levels.length === 0 || c.levels.length > MAX_LEVELS) {
    return `levels must be a non-empty array of at most ${MAX_LEVELS} entries`
  }
  for (let i = 0; i < c.levels.length; i++) {
    const lv = c.levels[i]
    if (!lv || typeof lv !== 'object' || Array.isArray(lv)) return `levels[${i}] must be an object`
    const l = lv as Record<string, unknown>
    if (!isDotPathIdentifier(l.field))
      return `levels[${i}].field must be a valid field name (one dot-path hop max)`
    if (l.label !== undefined && (typeof l.label !== 'string' || !l.label)) {
      return `levels[${i}].label must be a non-empty string`
    }
  }

  if (c.leaf_columns !== undefined) {
    if (!Array.isArray(c.leaf_columns)) return 'leaf_columns must be an array'
    for (let i = 0; i < c.leaf_columns.length; i++) {
      const e = c.leaf_columns[i]
      if (typeof e === 'string') {
        if (!isDotPathIdentifier(e))
          return `leaf_columns[${i}] must be a valid field name (one dot-path hop max)`
        continue
      }
      if (!e || typeof e !== 'object' || Array.isArray(e)) {
        return `leaf_columns[${i}] must be a field name or an object`
      }
      const spec = e as Record<string, unknown>
      if (!isDotPathIdentifier(spec.field))
        return `leaf_columns[${i}].field must be a valid field name (one dot-path hop max)`
      if (spec.label !== undefined && (typeof spec.label !== 'string' || !spec.label)) {
        return `leaf_columns[${i}].label must be a non-empty string`
      }
      if (spec.format !== undefined && !COLUMN_FORMATS.includes(spec.format as ColumnFormat)) {
        return `leaf_columns[${i}].format must be one of: ${COLUMN_FORMATS.join(', ')}`
      }
      if (spec.color !== undefined && (typeof spec.color !== 'string' || !spec.color)) {
        return `leaf_columns[${i}].color must be a non-empty string`
      }
    }
  }

  if (c.merge_leaf_by !== undefined) {
    if (!Array.isArray(c.merge_leaf_by) || c.merge_leaf_by.length === 0) {
      return 'merge_leaf_by must be a non-empty array'
    }
    for (let i = 0; i < c.merge_leaf_by.length; i++) {
      if (!isDotPathIdentifier(c.merge_leaf_by[i])) {
        return `merge_leaf_by[${i}] must be a valid field name (one dot-path hop max)`
      }
    }
  }

  if (!Array.isArray(c.measures) || c.measures.length === 0 || c.measures.length > MAX_MEASURES) {
    return `measures must be a non-empty array of at most ${MAX_MEASURES} entries`
  }
  const seenKeys = new Set<string>()
  for (let i = 0; i < c.measures.length; i++) {
    const m = c.measures[i]
    if (!m || typeof m !== 'object' || Array.isArray(m)) return `measures[${i}] must be an object`
    const mm = m as Record<string, unknown>
    if (!isPlainIdentifier(mm.key)) return `measures[${i}].key must be a valid identifier`
    if (seenKeys.has(mm.key as string)) return `measures[${i}].key is a duplicate`
    seenKeys.add(mm.key as string)
    if (typeof mm.label !== 'string' || !mm.label) {
      return `measures[${i}].label must be a non-empty string`
    }
    if (!isDotPathIdentifier(mm.sum)) {
      return `measures[${i}].sum must be a valid field name (one dot-path hop max)`
    }
    if (mm.format !== undefined && !MEASURE_FORMATS.includes(mm.format as MeasureFormat)) {
      return `measures[${i}].format must be one of: ${MEASURE_FORMATS.join(', ')}`
    }
    if (mm.filter !== undefined) {
      if (!Array.isArray(mm.filter)) return `measures[${i}].filter must be an array`
      for (let j = 0; j < mm.filter.length; j++) {
        const f = mm.filter[j]
        if (!f || typeof f !== 'object' || Array.isArray(f)) {
          return `measures[${i}].filter[${j}] must be an object`
        }
        const ff = f as Record<string, unknown>
        if (!isDotPathIdentifier(ff.field)) {
          return `measures[${i}].filter[${j}].field must be a valid field name (one dot-path hop max)`
        }
        if (ff.op !== 'eq' && ff.op !== 'neq' && ff.op !== 'nnull') {
          return `measures[${i}].filter[${j}].op must be eq, neq, or nnull`
        }
        if (ff.op !== 'nnull' && ff.value === undefined) {
          return `measures[${i}].filter[${j}].value is required for op "${ff.op}"`
        }
      }
    }
  }

  if (c.show_totals !== undefined && typeof c.show_totals !== 'boolean') {
    return 'show_totals must be a boolean'
  }

  return null
}

// ─── Render-time row resolution ─────────────────────────────────────────────

// eq/neq/nnull evaluated per fetched row value — same op set as static_filter
// but applied in JS (not SQL) since a row's measure contribution depends on
// values that may themselves come from a one-hop dot-path. Numbers/strings
// compare via String() coercion, mirroring how static_filter's SQL `where`
// compares a typed column against a JSON-decoded config value.
function evalMeasureFilter(raw: unknown, op: 'eq' | 'neq' | 'nnull', value?: unknown): boolean {
  if (op === 'nnull') return raw != null
  const matches = String(raw ?? '') === String(value)
  return op === 'eq' ? matches : !matches
}

interface LevelInfo {
  field: string
  label: string
  /** Related collection to batch-resolve this level's raw values against, when the field is itself an M2O FK. */
  labelSourceCollection: string | null
}

export async function resolveRollupRows(
  database: Knex,
  config: RollupConfig,
  /** null = the host record does not exist yet: nothing to walk, the tree is
   *  built from `staged` alone (a new record's pending lines + allocations). */
  recordId: string | null,
  logger: Logger = consoleLogger,
  staged?: RollupStaged
): Promise<RollupResult> {
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
  const configError = validateRollupConfig(config, relations)
  if (configError) badConfig(`rollup: ${configError}`)

  const { idSet, truncated: walkTruncated } =
    recordId == null
      ? { idSet: [] as Array<string | number>, truncated: false }
      : await walkReversePath(database, config, relations, recordId, logger, 'rollup')
  let truncated = walkTruncated

  const leafSpecs = normalizeColumnSpecs(config.leaf_columns)
  const levelFields = config.levels.map((l) => l.field)
  const measureSumFields = config.measures.map((m) => m.sum)
  const measureFilterFields = config.measures.flatMap((m) => (m.filter ?? []).map((f) => f.field))

  const allSpecs = [
    ...new Set([
      ...levelFields,
      ...leafSpecs.map((s) => s.field),
      ...measureSumFields,
      ...measureFilterFields
    ])
  ]
  const dotSpecs: DotSpec[] = splitDotSpecs(allSpecs)
  const dotSpecByRaw = new Map(dotSpecs.map((d) => [d.raw, d]))
  const plainSpecs = allSpecs.filter((s) => !dotSpecByRaw.has(s))

  const selectFields = new Set<string>(['id'])
  for (const f of plainSpecs) selectFields.add(f)
  for (const d of dotSpecs) selectFields.add(d.fkField)

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
      logger.warn({ collection: config.collection }, 'rollup: target query truncated at cap')
    }
  }

  // Staged (unsaved) changes merge BEFORE dot/label resolution so created
  // rows' FK values resolve labels exactly like saved ones. Keys are
  // whitelisted against the config's own field set — nothing client-invented
  // reaches grouping — and values must be primitives.
  const pendingIds = new Set<string>()
  if (staged) {
    const allowedKeys = new Set<string>([...selectFields, ...allSpecs])
    const sanitize = (v: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v)) {
        if (!allowedKeys.has(k)) continue
        if (val !== null && typeof val === 'object') continue
        out[k] = val
      }
      return out
    }
    const del = new Set((staged.deleted ?? []).slice(0, 500).map(String))
    if (del.size) targetRows = targetRows.filter((r) => !del.has(String(r.id)))
    const upd = new Map(
      (staged.updated ?? []).slice(0, 500).map((u) => [String(u.id), sanitize(u.values ?? {})])
    )
    if (upd.size) {
      targetRows = targetRows.map((r) => {
        const v = upd.get(String(r.id))
        if (!v) return r
        pendingIds.add(String(r.id))
        return { ...r, ...v }
      })
    }
    ;(staged.created ?? []).slice(0, 200).forEach((v, i) => {
      const row = { ...sanitize(v ?? {}), id: `__staged_${i}` }
      pendingIds.add(String(row.id))
      targetRows.push(row)
    })
  }

  const dotValueMaps = await resolveDotSpecValues(
    database,
    config.collection,
    relations,
    dotSpecs,
    targetRows,
    logger,
    'rollup'
  )

  const getRaw = (row: Record<string, unknown>, field: string): unknown => {
    const dot = dotSpecByRaw.get(field)
    if (dot) {
      // A staged row whose parent is itself unsaved has no FK to resolve
      // through — it carries the dotted value as a literal key instead.
      if (row[field] !== undefined) return row[field]
      const raw = row[dot.fkField]
      const map = dotValueMaps.get(`${dot.fkField}.${dot.subField}`)
      return raw == null ? null : (map?.get(String(raw)) ?? raw)
    }
    return row[field] ?? null
  }

  // Level label resolution: a level's raw value is a display label candidate
  // when the (dot-path tail or plain) field is itself an M2O FK on the
  // collection it's read from — batched per level via resolveRelatedLabels,
  // same as review_list's stamp_user label resolution.
  const levelInfos: LevelInfo[] = config.levels.map((lvl) => {
    const dot = dotSpecByRaw.get(lvl.field)
    let hostCollection: string | undefined
    let fieldName: string
    if (dot) {
      const rel = findM2oRelation(relations, dot.fkField, { many: config.collection })
      hostCollection = rel?.one_collection ?? undefined
      fieldName = dot.subField
    } else {
      hostCollection = config.collection
      fieldName = lvl.field
    }
    const fkRel = hostCollection
      ? findM2oRelation(relations, fieldName, { many: hostCollection })
      : undefined
    return {
      field: lvl.field,
      label: lvl.label || lvl.field,
      labelSourceCollection: fkRel?.one_collection ?? null
    }
  })

  const levelLabelMaps = await Promise.all(
    levelInfos.map((info) =>
      info.labelSourceCollection
        ? resolveRelatedLabels(
            database,
            info.labelSourceCollection,
            targetRows.map((r) => getRaw(r, info.field))
          )
        : Promise.resolve(null)
    )
  )

  const rows: RollupRow[] = targetRows.map((row) => {
    const levels = config.levels.map((lvl) => getRaw(row, lvl.field))
    const level_labels: Array<string | null> = levels.map((raw, i) => {
      if (raw == null) return null
      return levelLabelMaps[i]?.get(String(raw)) ?? null
    })

    const values: Record<string, unknown> = {}
    for (const spec of leafSpecs) values[spec.field] = getRaw(row, spec.field)

    const measures: Record<string, number> = {}
    for (const m of config.measures) {
      const passes = (m.filter ?? []).every((f) =>
        evalMeasureFilter(getRaw(row, f.field), f.op, f.value)
      )
      const n = Number(getRaw(row, m.sum))
      measures[m.key] = passes && Number.isFinite(n) ? n : 0
    }

    return {
      id: row.id as string | number,
      levels,
      level_labels,
      values,
      measures,
      ...(pendingIds.has(String(row.id)) ? { pending: true } : {})
    }
  })

  return {
    rows,
    columns: {
      levels: config.levels.map((l) => ({ field: l.field, label: l.label || l.field })),
      leaf_columns: leafSpecs.map((s) => ({
        field: s.field,
        label: s.label || s.field,
        format: s.format ?? null,
        color: s.color ?? null
      })),
      measures: config.measures.map((m) => ({
        key: m.key,
        label: m.label,
        format: m.format ?? null
      }))
    },
    truncated
  }
}
