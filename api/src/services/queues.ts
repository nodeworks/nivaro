import { db } from '../db/index.js'
import { type ApprovalChainStep, resolveStepApprovers } from '../routes/approvals.js'
import {
  type AtRiskRuleRow,
  evaluateRows,
  parseActiveRules,
  referencedFields
} from '../routes/at-risk.js'
import { computeStatusBatch, type SlaInstanceRow } from '../routes/sla.js'
import type { CMSRelation, User } from '../types.js'
import { getCollection, getRelations } from './collections.js'
import { selectInChunks } from './db-batch.js'
import { extractTemplateFields, resolveDisplayValue } from './display-value.js'
import { can } from './permissions.js'
import { parseJson, type ResolvedOwner, resolveStateOwnersBatch } from './pipeline-engine.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export type QueueSourceType = 'collection' | 'tasks' | 'approvals' | 'owned_by_me'

export type QueueConditionOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'null'
  | 'nnull'

export interface QueueCondition {
  field: string
  op: QueueConditionOp
  value?: unknown
}

export interface QueueSourceRow {
  id: number
  queue_id: string
  type: QueueSourceType
  collection: string | null
  filters: string | null
  state_values: string | null
  /** 'include' (default) keeps only the listed states; 'exclude' drops them (stateless items kept). */
  state_mode?: 'include' | 'exclude' | null
  /** Item-column display template ({{field}} tokens). Null = collection display_template, then fallback. */
  label_template?: string | null
  sla_filter: string | null
  extra_fields: string | null
  /** JSON: Record<extraFieldPath, { enabled?: boolean; layout_id?: number | null }> — per-column drill-down config. */
  drilldown?: string | null
  sort: number
}

// State filtering semantics shared by the live resolver and the materialization
// write-path matcher. Include: only listed states pass (stateless items drop
// unless the '__none__' sentinel is listed). Exclude: listed states drop,
// everything else passes (stateless items drop only when '__none__' is listed).
export const NO_STATE_SENTINEL = '__none__'

export function stateFilterKeep(
  stateKey: string | null,
  stateValues: string[],
  mode: 'include' | 'exclude'
): boolean {
  const matches =
    stateKey == null ? stateValues.includes(NO_STATE_SENTINEL) : stateValues.includes(stateKey)
  return mode === 'exclude' ? !matches : matches
}

export interface QueueRow {
  id: string
  name: string
  description: string | null
  icon: string | null
  color: string | null
  owner: string
  is_shared: boolean | number
  role_id: string | null
  view_mode: 'table' | 'kanban' | 'both'
  is_active: boolean | number
  materialized: boolean | number
  claims_enabled: boolean | number
  column_aliases: string | null
  display_config: string | null
  created_at: Date
  updated_at: Date | null
}

export const QUEUE_VIEWS = ['table', 'kanban', 'workload'] as const
export type QueueViewKind = (typeof QUEUE_VIEWS)[number]

const DEFAULTABLE_SCOPES = ['mine', 'unowned', 'all'] as const
export type QueueDefaultScope = (typeof DEFAULTABLE_SCOPES)[number]

export interface QueueDisplayConfig {
  views: QueueViewKind[]
  default_view: QueueViewKind
  default_scope: QueueDefaultScope
  work_next: boolean
  bulk_actions: boolean
}

export const DEFAULT_DISPLAY_CONFIG: QueueDisplayConfig = {
  views: [...QUEUE_VIEWS],
  default_view: 'table',
  default_scope: 'all',
  work_next: true,
  bulk_actions: true
}

/**
 * Fill defaults and coerce invalid values so consumers never see a partial
 * config. 'table' is always present in views; default_view must be a member
 * of views; NULL/garbage input yields DEFAULT_DISPLAY_CONFIG.
 */
export function normalizeDisplayConfig(raw: unknown): QueueDisplayConfig {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >
  const rawViews = Array.isArray(src.views) ? src.views : [...QUEUE_VIEWS]
  const views = QUEUE_VIEWS.filter((v) => v === 'table' || rawViews.includes(v))
  const default_view = views.includes(src.default_view as QueueViewKind)
    ? (src.default_view as QueueViewKind)
    : 'table'
  const default_scope = DEFAULTABLE_SCOPES.includes(src.default_scope as QueueDefaultScope)
    ? (src.default_scope as QueueDefaultScope)
    : 'all'
  return {
    views,
    default_view,
    default_scope,
    work_next: src.work_next !== false,
    bulk_actions: src.bulk_actions !== false
  }
}

export interface QueueOwner {
  id: string
  name: string
}

export interface QueueItem {
  collection: string
  item_id: string
  label: string
  state: string | null
  state_color: string | null
  owners: QueueOwner[]
  sla_status: 'ok' | 'warning' | 'breached' | null
  at_risk: boolean
  aging_hours: number | null
  claimed_by: QueueOwner | null
  extra?: Record<string, unknown>
  /** Related-record ids per relation extra-field path — powers drill-down. */
  extra_ids?: Record<string, string[]>
  url: string
}

export interface QueueStats {
  total: number
  by_state: Record<string, number>
  unowned: number
  sla_warning: number
  sla_breached: number
  at_risk: number
}

export interface WorkloadRow {
  owner: QueueOwner | null
  count: number
  max_wip: number | null
}

export type QueueScope = 'mine' | 'unowned' | 'all' | 'claimed'

export const QUEUE_SANITY_CEILING = 20000
export const PROMOTION_THRESHOLD = 5000
// Backfill resolves sources in a background Inngest job, so it gets a far higher
// circuit breaker than interactive reads — the materialized cache must hold the
// FULL matching set or its SQL-aggregate stats would inherit the interactive cap
// (a 50k-row source materializing only 20k rows made the stat strip report 20,000).
export const BACKFILL_CEILING = 200000

export interface SourceIdMeta {
  collection: string
  item_id: string
  state: string | null
  sla_status: 'ok' | 'warning' | 'breached' | null
}

export interface SourceResult {
  items: QueueItem[]
  matchedCount: number
  truncated: boolean
  /** Light per-item metadata for the FULL matched set (pre-sanity-ceiling), so
   *  stats can stay exact even when the hydrated rows were truncated. Capped at
   *  BACKFILL_CEILING — absent when even that was exceeded. */
  idMeta?: SourceIdMeta[]
}

// Exact live-path stats from the resolvers' full id metadata: total/by_state/
// sla counts dedupe across sources by collection:item_id (first occurrence,
// matching mergeSourceResults). unowned/at_risk need owner and at-risk
// resolution, which only ran for the hydrated (possibly capped) subset — they
// come from it as the best available approximation when truncated.
export function computeStatsFromIdMeta(
  metaBatches: SourceIdMeta[][],
  hydratedScoped: QueueItem[]
): QueueStats {
  const seen = new Set<string>()
  const by_state: Record<string, number> = {}
  let total = 0
  let sla_warning = 0
  let sla_breached = 0
  for (const batch of metaBatches) {
    for (const m of batch) {
      const key = `${m.collection}:${m.item_id}`
      if (seen.has(key)) continue
      seen.add(key)
      total++
      const stateKey = m.state ?? 'none'
      by_state[stateKey] = (by_state[stateKey] ?? 0) + 1
      if (m.sla_status === 'warning') sla_warning++
      if (m.sla_status === 'breached') sla_breached++
    }
  }
  let unowned = 0
  let at_risk = 0
  for (const item of hydratedScoped) {
    if (item.owners.length === 0) unowned++
    if (item.at_risk) at_risk++
  }
  return { total, by_state, unowned, sla_warning, sla_breached, at_risk }
}

export function applySanityCeiling(
  ids: string[],
  ceiling: number
): { ids: string[]; truncated: boolean; matchedCount: number } {
  const matchedCount = ids.length
  const truncated = matchedCount > ceiling
  return { ids: truncated ? ids.slice(0, ceiling) : ids, truncated, matchedCount }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

export function mergeSourceResults(results: QueueItem[][]): QueueItem[] {
  const seen = new Set<string>()
  const out: QueueItem[] = []
  for (const batch of results) {
    for (const item of batch) {
      const key = `${item.collection}:${item.item_id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
  }
  return out
}

export function applyScopeFilter(
  items: QueueItem[],
  scope: QueueScope,
  userId: string
): QueueItem[] {
  if (scope === 'all') return items
  if (scope === 'unowned') return items.filter((i) => i.owners.length === 0)
  if (scope === 'claimed') return items.filter((i) => i.claimed_by?.id === userId)
  return items.filter((i) => i.owners.some((o) => o.id === userId))
}

export function attachClaims(items: QueueItem[], claims: Map<string, QueueOwner>): QueueItem[] {
  return items.map((item) => ({
    ...item,
    claimed_by: claims.get(`${item.collection}:${item.item_id}`) ?? null
  }))
}

// True when the request carries at least one active column filter — drives the
// optional filtered_stats block (stat strip "277 / 504" display).
export function hasActiveColumnFilters(filters: Record<string, unknown> | undefined): boolean {
  if (!filters) return false
  return Object.values(filters).some((v) => {
    if (v == null || v === '') return false
    if (Array.isArray(v)) return v.length > 0
    return true
  })
}

// Multiselect filters arrive as arrays and match ANY value (OR semantics);
// single strings keep the original behavior.
function matchesAny(value: unknown, test: (v: string) => boolean): boolean {
  if (Array.isArray(value)) return value.some((v) => test(String(v)))
  return test(String(value))
}

export function applyColumnFilters(
  items: QueueItem[],
  filters: Record<string, unknown>
): QueueItem[] {
  return items.filter((item) => {
    for (const [key, value] of Object.entries(filters)) {
      if (value == null || value === '') continue
      if (Array.isArray(value) && value.length === 0) continue

      if (key === 'aging_hours') {
        const range = value as { min?: number; max?: number }
        if (item.aging_hours == null) return false
        if (range.min != null && item.aging_hours < range.min) return false
        if (range.max != null && item.aging_hours > range.max) return false
        continue
      }
      if (key === 'at_risk') {
        if (item.at_risk !== (value === 'yes')) return false
        continue
      }
      if (key === 'collection' && !matchesAny(value, (v) => item.collection === v)) return false
      else if (key === 'state' && !matchesAny(value, (v) => item.state === v)) return false
      else if (key === 'sla_status' && item.sla_status !== value) return false
      else if (key === 'label') {
        const haystack = item.label.toLowerCase()
        if (!matchesAny(value, (needle) => haystack.includes(needle.toLowerCase()))) return false
      }
      else if (key === 'owners') {
        const names = item.owners.map((o) => o.name.toLowerCase()).join(' ')
        if (!names.includes(String(value).toLowerCase())) return false
      } else if (key.startsWith('extra.')) {
        const path = key.slice('extra.'.length)
        const v = item.extra?.[path]
        if (v == null) return false
        const haystack = String(v).toLowerCase()
        if (!matchesAny(value, (needle) => haystack.includes(needle.toLowerCase()))) {
          return false
        }
      }
    }
    return true
  })
}

const SLA_SEVERITY: Record<string, number> = { ok: 0, warning: 1, breached: 2 }

// Composite "do this first" score: SLA severity dominates (breached always
// outranks warning outranks ok/none), at-risk breaks ties within a band, and
// aging breaks ties within that — capped at 499 so age can never cross a band
// boundary. Used by sort=-priority (most urgent first).
export function computePriorityScore(item: QueueItem): number {
  const slaRank = item.sla_status === 'breached' ? 2 : item.sla_status === 'warning' ? 1 : 0
  return slaRank * 1000 + (item.at_risk ? 500 : 0) + Math.min(item.aging_hours ?? 0, 499)
}

function sortValue(item: QueueItem, key: string): string | number | null {
  if (key === 'collection') return item.collection
  if (key === 'label') return item.label
  if (key === 'state') return item.state
  if (key === 'owners') return item.owners.map((o) => o.name).join(', ')
  if (key === 'aging_hours') return item.aging_hours
  if (key === 'sla_status') return item.sla_status ? (SLA_SEVERITY[item.sla_status] ?? null) : null
  if (key === 'at_risk') return item.at_risk ? 1 : 0
  if (key === 'priority') return computePriorityScore(item)
  if (key.startsWith('extra.')) {
    const v = item.extra?.[key.slice('extra.'.length)]
    return v == null ? null : String(v)
  }
  return null
}

export function sortItems(items: QueueItem[], sort: string): QueueItem[] {
  if (!sort) return items
  const desc = sort.startsWith('-')
  const key = desc ? sort.slice(1) : sort
  // Nulls always sort last, in BOTH directions — only the relative order of
  // non-null values flips with direction. A plain ascending-sort-then-reverse
  // would incorrectly push nulls to the front on descending sorts.
  return [...items].sort((a, b) => {
    const av = sortValue(a, key)
    const bv = sortValue(b, key)
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    const cmp =
      typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv))
    return desc ? -cmp : cmp
  })
}

export function computeAvailableValues(items: QueueItem[]): {
  collection: string[]
  state: string[]
} {
  const collections = new Set<string>()
  const states = new Set<string>()
  for (const item of items) {
    collections.add(item.collection)
    if (item.state) states.add(item.state)
  }
  return { collection: [...collections].sort(), state: [...states].sort() }
}

export function paginateItems<T>(
  items: T[],
  page?: number,
  limit?: number
): { items: T[]; total: number } {
  const total = items.length
  if (page == null || limit == null) return { items, total }
  const start = (page - 1) * limit
  return { items: items.slice(start, start + limit), total }
}

export function parsePaginationParams(
  pageRaw: string | undefined,
  limitRaw: string | undefined
): { page: number; limit: number } {
  const pageNum = Number(pageRaw)
  const page = Number.isFinite(pageNum) && pageNum > 0 ? Math.floor(pageNum) : 1
  const limitNum = Number(limitRaw)
  const limit = Number.isFinite(limitNum) && limitNum > 0 ? Math.min(Math.floor(limitNum), 100) : 25
  return { page, limit }
}

export function computeStats(items: QueueItem[]): QueueStats {
  const by_state: Record<string, number> = {}
  let unowned = 0
  let sla_warning = 0
  let sla_breached = 0
  let at_risk = 0
  for (const item of items) {
    const key = item.state ?? 'none'
    by_state[key] = (by_state[key] ?? 0) + 1
    if (item.owners.length === 0) unowned++
    if (item.sla_status === 'warning') sla_warning++
    if (item.sla_status === 'breached') sla_breached++
    if (item.at_risk) at_risk++
  }
  return { total: items.length, by_state, unowned, sla_warning, sla_breached, at_risk }
}

const UNASSIGNED_KEY = '__unassigned__'

export function groupByOwner(
  items: QueueItem[]
): Map<string, { owner: QueueOwner | null; count: number }> {
  const groups = new Map<string, { owner: QueueOwner | null; count: number }>()
  for (const item of items) {
    if (item.owners.length === 0) {
      const existing = groups.get(UNASSIGNED_KEY) ?? { owner: null, count: 0 }
      existing.count++
      groups.set(UNASSIGNED_KEY, existing)
      continue
    }
    for (const owner of item.owners) {
      const existing = groups.get(owner.id) ?? { owner, count: 0 }
      existing.count++
      groups.set(owner.id, existing)
    }
  }
  return groups
}

export function filterBySlaStatus(
  ids: string[],
  slaMap: Record<string, { status: string }>,
  filter: string | null
): string[] {
  if (!filter) return ids
  return ids.filter((id) => slaMap[id]?.status === filter)
}

export function computeAvailableExtraFields(sources: QueueSourceRow[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const source of sources) {
    if (source.type !== 'collection') continue
    const fields = (parseJson(source.extra_fields) as string[] | null) ?? []
    for (const field of fields) {
      if (seen.has(field)) continue
      seen.add(field)
      out.push(field)
    }
  }
  return out
}

export interface ExtraFieldMeta {
  path: string
  /** 'relation' → the final value comes from a related collection (combobox-filterable);
   *  'plain' → a direct/terminal column (text filter). */
  kind: 'relation' | 'plain'
  relation_type?: 'm2o' | 'm2m' | 'o2m'
  target_collection?: string
  display_field?: string
}

/** Classify each configured extra-field path so the admin can render the right
 *  filter control: relation paths (regions.short_name, project.project_type.name)
 *  become server-searchable comboboxes against the FINAL hop's target collection. */
export async function computeExtraFieldMeta(
  sources: QueueSourceRow[],
  database: typeof db = db
): Promise<ExtraFieldMeta[]> {
  const out: ExtraFieldMeta[] = []
  // Full relations table (small): m2m classification needs the SIBLING junction
  // row (junction → related collection), which a per-collection fetch misses —
  // neither of that row's sides names the base collection.
  const allRelations = (await database('nivaro_relations')) as CMSRelation[]

  const paths = new Map<string, string>() // path -> base collection
  for (const source of sources) {
    if (source.type !== 'collection' || !source.collection) continue
    const fields = (parseJson(source.extra_fields) as string[] | null) ?? []
    for (const f of fields) if (!paths.has(f)) paths.set(f, source.collection)
  }

  for (const [path, baseCollection] of paths) {
    const segments = path.split('.')
    let current = baseCollection
    let lastRelation: RelationSegmentInfo | null = null
    let plain = segments.length === 1
    for (let i = 0; i < segments.length - 1; i++) {
      const info = classifyRelationSegment(current, segments[i], allRelations)
      if (!info) {
        plain = true
        break
      }
      lastRelation = info
      current = info.relatedCollection
    }
    if (plain || !lastRelation) {
      out.push({ path, kind: 'plain' })
    } else {
      out.push({
        path,
        kind: 'relation',
        relation_type: lastRelation.type,
        target_collection: lastRelation.relatedCollection,
        display_field: segments[segments.length - 1]
      })
    }
  }
  return out
}

export interface RelationSegmentInfo {
  type: 'm2o' | 'm2m' | 'o2m'
  relatedCollection: string
  manyField?: string
  junction?: string
  junctionFkToParent?: string
  junctionFkToOther?: string
}

export function classifyRelationSegment(
  collection: string,
  segment: string,
  relations: CMSRelation[]
): RelationSegmentInfo | null {
  const m2o = relations.find(
    (r) =>
      r.many_collection === collection &&
      r.many_field === segment &&
      r.junction_field === null &&
      r.one_collection
  )
  if (m2o) return { type: 'm2o', relatedCollection: m2o.one_collection as string }

  const m2mParent = relations.find(
    (r) =>
      r.one_collection === collection &&
      r.one_field === segment &&
      r.junction_field !== null &&
      r.many_collection
  )
  if (m2mParent) {
    const target = relations.find(
      (r) =>
        r.many_collection === m2mParent.many_collection &&
        r.many_field === m2mParent.junction_field &&
        r.one_collection
    )
    if (target?.one_collection) {
      return {
        type: 'm2m',
        relatedCollection: target.one_collection,
        junction: m2mParent.many_collection,
        junctionFkToParent: m2mParent.many_field,
        junctionFkToOther: m2mParent.junction_field as string
      }
    }
  }

  const o2m = relations.find(
    (r) =>
      r.one_collection === collection &&
      r.one_field === segment &&
      r.junction_field === null &&
      r.many_collection
  )
  if (o2m)
    return {
      type: 'o2m',
      relatedCollection: o2m.many_collection,
      manyField: o2m.many_field as string
    }

  return null
}

export function formatMultiValueCell(values: string[], totalCount: number, cap = 3): string {
  if (totalCount === 0) return ''
  const shown = values.slice(0, cap)
  const remaining = totalCount - shown.length
  return remaining > 0 ? `${shown.join(', ')} +${remaining} more` : shown.join(', ')
}

export interface ConditionBuilder {
  where(field: string, value: unknown): ConditionBuilder
  where(field: string, op: string, value: unknown): ConditionBuilder
  whereNot(field: string, value: unknown): ConditionBuilder
  whereNull(field: string): ConditionBuilder
  whereNotNull(field: string): ConditionBuilder
}

export function applyQueueConditions(q: ConditionBuilder, conditions: QueueCondition[]): void {
  for (const c of conditions) {
    switch (c.op) {
      case 'eq':
        q.where(c.field, c.value)
        break
      case 'neq':
        q.whereNot(c.field, c.value)
        break
      case 'contains':
        q.where(c.field, 'like', `%${String(c.value)}%`)
        break
      case 'gt':
        q.where(c.field, '>', c.value)
        break
      case 'gte':
        q.where(c.field, '>=', c.value)
        break
      case 'lt':
        q.where(c.field, '<', c.value)
        break
      case 'lte':
        q.where(c.field, '<=', c.value)
        break
      case 'null':
        q.whereNull(c.field)
        break
      case 'nnull':
        q.whereNotNull(c.field)
        break
    }
  }
}

// ─── Labels ───────────────────────────────────────────────────────────────────

const LABEL_CANDIDATES = ['title', 'name', 'label', 'subject']

/** Render {{field}}-template labels for a set of ids of one collection. Template
 *  fields are limited to REAL columns of the collection (dotted tokens render
 *  empty — same contract as ItemEdit display templates). */
export async function renderTemplateLabels(
  collection: string,
  ids: string[],
  template: string
): Promise<Record<string, string>> {
  const labels: Record<string, string> = {}
  if (ids.length === 0) return labels
  try {
    const fieldRows = (await db('nivaro_fields').where({ collection }).select('field')) as Array<{
      field: string
    }>
    const columns = new Set(fieldRows.map((f) => f.field))
    const wanted = extractTemplateFields(template).filter((f) => columns.has(f))
    // extractTemplateFields always seeds 'id' — dedupe or MSSQL/tedious returns the
    // duplicated column as a comma-joined value ("283639,283639"), corrupting every
    // label key and silently falling the Item column back to raw ids.
    const selectCols = [...new Set(['id', ...wanted])]
    const rows = (await selectInChunks(ids, 2000, (chunk) =>
      db(collection).whereIn('id', chunk).select(selectCols)
    )) as Array<Record<string, unknown>>
    for (const row of rows) {
      labels[`${collection}:${row.id}`] = resolveDisplayValue(row, template)
    }
  } catch {
    // Collection table may not exist or be queryable — labels stay empty
  }
  return labels
}

/** Best-effort display labels for a set of {collection,item_id} pairs. Honors the
 *  collection's display_template when configured, else falls back to the first of
 *  title/name/label/subject. Mirrors tasks.ts getItemLabels(). */
export async function getLabels(
  itemsByCollection: Map<string, Set<string>>
): Promise<Record<string, string>> {
  const labels: Record<string, string> = {}
  for (const [collection, ids] of itemsByCollection) {
    try {
      const colMeta = (await db('nivaro_collections')
        .where({ collection })
        .first('display_template')) as { display_template: string | null } | undefined
      if (colMeta?.display_template) {
        Object.assign(
          labels,
          await renderTemplateLabels(collection, [...ids], colMeta.display_template)
        )
        continue
      }

      const fields = (await db('nivaro_fields').where({ collection }).select('field')) as Array<{
        field: string
      }>
      const fieldNames = fields.map((f) => f.field)
      const labelField = LABEL_CANDIDATES.find((c) => fieldNames.includes(c))
      const pk = fieldNames.includes('id') ? 'id' : null
      if (!labelField || !pk) continue

      const rows = (await selectInChunks([...ids], 2000, (chunk) =>
        db(collection).whereIn(pk, chunk).select(pk, labelField)
      )) as Array<Record<string, unknown>>
      for (const row of rows) {
        const value = row[labelField]
        if (value != null) labels[`${collection}:${row[pk]}`] = String(value)
      }
    } catch {
      // Collection table may not exist or be queryable — labels stay empty
    }
  }
  return labels
}

export async function getClaims(queueId: string): Promise<Map<string, QueueOwner>> {
  const rows = (await db('nivaro_queue_claims as c')
    .join('nivaro_users as u', 'c.claimed_by', 'u.id')
    .where('c.queue_id', queueId)
    .select(
      'c.source_collection',
      'c.item_id',
      'u.id',
      'u.first_name',
      'u.last_name',
      'u.email'
    )) as Array<{
    source_collection: string
    item_id: string
    id: string
    first_name: string | null
    last_name: string | null
    email: string
  }>

  const out = new Map<string, QueueOwner>()
  for (const r of rows) {
    out.set(`${r.source_collection}:${r.item_id}`, {
      id: r.id,
      name: userDisplayName({ first_name: r.first_name, last_name: r.last_name, email: r.email })
    })
  }
  return out
}

function userDisplayName(row: {
  first_name: string | null
  last_name: string | null
  email?: string
}): string {
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ')
  return name || row.email || 'Unknown'
}

// ─── Relation path resolution ──────────────────────────────────────────────────

// Resolved cell for one row: the display string plus the id(s) of the FINAL
// related entity on the path (empty for plain columns) — ids power drill-down.
export interface PathValue {
  value: string
  ids: string[]
}

export async function resolvePathValues(
  collection: string,
  ids: string[],
  segments: string[],
  relationsCache: Map<string, CMSRelation[]>
): Promise<Map<string, PathValue>> {
  if (ids.length === 0 || segments.length === 0) return new Map()

  let relations = relationsCache.get(collection)
  if (!relations) {
    relations = await getRelations(collection)
    relationsCache.set(collection, relations)
  }

  const [head, ...rest] = segments
  const classified = classifyRelationSegment(collection, head, relations)

  if (!classified) {
    const rows = await selectInChunks(ids, 2000, (chunk) =>
      db(collection).whereIn('id', chunk).select(['id', head])
    )
    const out = new Map<string, PathValue>()
    for (const row of rows as Array<Record<string, unknown>>) {
      const v = row[head]
      out.set(String(row.id), { value: v == null ? '' : String(v), ids: [] })
    }
    return out
  }

  if (classified.type === 'm2o') {
    const rows = await selectInChunks(ids, 2000, (chunk) =>
      db(collection).whereIn('id', chunk).select(['id', head])
    )
    const fkByRowId = new Map<string, string>()
    const relatedIds = new Set<string>()
    for (const row of rows as Array<Record<string, unknown>>) {
      if (row[head] == null) continue
      const fk = String(row[head])
      fkByRowId.set(String(row.id), fk)
      relatedIds.add(fk)
    }
    if (relatedIds.size === 0) return new Map()

    if (rest.length > 0) {
      const nested = await resolvePathValues(
        classified.relatedCollection,
        [...relatedIds],
        rest,
        relationsCache
      )
      const out = new Map<string, PathValue>()
      for (const [rowId, fk] of fkByRowId) {
        const v = nested.get(fk)
        // A plain leaf reports no ids — the final ENTITY on the path is then the
        // record this hop resolved to (e.g. project_type.name -> the project_types
        // row), so substitute this hop's fk. Deeper m2o/m2m hops report their own.
        if (v !== undefined) out.set(rowId, v.ids.length > 0 ? v : { value: v.value, ids: [fk] })
      }
      return out
    }

    const relatedCol = await getCollection(classified.relatedCollection)
    const template = relatedCol?.display_template ?? null
    const selectFields = template ? extractTemplateFields(template) : ['*']
    const relatedRows = await selectInChunks([...relatedIds], 2000, (chunk) =>
      db(classified.relatedCollection).whereIn('id', chunk).select(selectFields)
    )
    const displayById = new Map<string, string>()
    for (const r of relatedRows as Array<Record<string, unknown>>) {
      displayById.set(String(r.id), resolveDisplayValue(r, template))
    }
    const out = new Map<string, PathValue>()
    for (const [rowId, fk] of fkByRowId) {
      const v = displayById.get(fk)
      if (v !== undefined) out.set(rowId, { value: v, ids: [fk] })
    }
    return out
  }

  // M2M / O2M — always resolved as a leaf (multi-value), regardless of remaining
  // segments. Chaining a path through a multi-valued relation into another field
  // is out of scope (see docs/superpowers/specs/2026-07-02-queue-extra-field-relations-design.md)
  // — a queue-owner path that does this simply resolves as if it ended here.
  const relatedCol = await getCollection(classified.relatedCollection)
  const template = relatedCol?.display_template ?? null
  const selectFields = template ? extractTemplateFields(template) : ['*']

  if (classified.type === 'o2m') {
    const manyField = classified.manyField as string
    const relatedRows = await selectInChunks(ids, 2000, (chunk) =>
      db(classified.relatedCollection)
        .whereIn(manyField, chunk)
        .select(rest.length > 0 ? [manyField, 'id'] : [manyField, ...selectFields])
    )
    const grouped = new Map<string, Record<string, unknown>[]>()
    for (const row of relatedRows as Array<Record<string, unknown>>) {
      const parentId = String(row[manyField])
      const list = grouped.get(parentId) ?? []
      list.push(row)
      grouped.set(parentId, list)
    }
    // Multi-valued hop with remaining segments: recurse the rest of the path
    // per related row and join the distinct results per parent.
    if (rest.length > 0) {
      const allRelatedIds = [...new Set((relatedRows as Array<Record<string, unknown>>).map((r) => String(r.id)))]
      const nested = await resolvePathValues(classified.relatedCollection, allRelatedIds, rest, relationsCache)
      return joinMultiHop(ids, grouped, nested)
    }
    const out = new Map<string, PathValue>()
    for (const rowId of ids) {
      const related = grouped.get(rowId) ?? []
      const values = related.slice(0, 3).map((r) => resolveDisplayValue(r, template))
      out.set(rowId, {
        value: formatMultiValueCell(values, related.length),
        ids: related.slice(0, 50).map((r) => String(r.id))
      })
    }
    return out
  }

  // m2m
  const junctionRows = await selectInChunks(ids, 2000, (chunk) =>
    db(`${classified.junction} as _j`)
      .whereIn(`_j.${classified.junctionFkToParent}`, chunk)
      .join(
        `${classified.relatedCollection} as _rel`,
        '_rel.id',
        `_j.${classified.junctionFkToOther}`
      )
      .select([
        `_j.${classified.junctionFkToParent} as __parent_id`,
        '_rel.id as __rel_id',
        ...selectFields.map((f) => `_rel.${f}`)
      ])
  )
  const grouped = new Map<string, Record<string, unknown>[]>()
  for (const row of junctionRows as Array<Record<string, unknown>>) {
    const parentId = String(row.__parent_id)
    const list = grouped.get(parentId) ?? []
    list.push(row)
    grouped.set(parentId, list)
  }
  if (rest.length > 0) {
    const allRelatedIds = [
      ...new Set(
        (junctionRows as Array<Record<string, unknown>>).map((r) => String(r.__rel_id ?? r.id))
      )
    ]
    const nested = await resolvePathValues(classified.relatedCollection, allRelatedIds, rest, relationsCache)
    const groupedIds = new Map<string, Record<string, unknown>[]>()
    for (const [parentId, list] of grouped) {
      groupedIds.set(parentId, list.map((r) => ({ id: r.__rel_id ?? r.id })))
    }
    return joinMultiHop(ids, groupedIds, nested)
  }
  const out = new Map<string, PathValue>()
  for (const rowId of ids) {
    const related = grouped.get(rowId) ?? []
    const values = related.slice(0, 3).map((r) => resolveDisplayValue(r, template))
    out.set(rowId, {
      value: formatMultiValueCell(values, related.length),
      ids: related.slice(0, 50).map((r) => String(r.__rel_id ?? r.id))
    })
  }
  return out
}

// Join a multi-valued hop's children through the resolved remainder of the
// path: per parent, collect each related row's resolved value, dedupe, and
// render up to 3 + "+N more"; ids = the FINAL entities' ids from the remainder.
function joinMultiHop(
  parentIds: string[],
  relatedByParent: Map<string, Record<string, unknown>[]>,
  nested: Map<string, PathValue>
): Map<string, PathValue> {
  const out = new Map<string, PathValue>()
  for (const parentId of parentIds) {
    const related = relatedByParent.get(parentId) ?? []
    const values: string[] = []
    const idSet = new Set<string>()
    for (const r of related) {
      const pv = nested.get(String(r.id))
      if (!pv) continue
      if (pv.value !== '' && !values.includes(pv.value)) values.push(pv.value)
      if (pv.ids.length > 0) for (const id of pv.ids) idSet.add(id)
      // Plain leaf remainder reports no ids — the final ENTITY is this hop's
      // related row (e.g. the workflow whose workflow_id we just read).
      else idSet.add(String(r.id))
    }
    if (values.length === 0 && idSet.size === 0) continue
    out.set(parentId, {
      value: formatMultiValueCell(values.slice(0, 3), values.length),
      ids: [...idSet].slice(0, 50)
    })
  }
  return out
}

// ─── Source resolvers ───────────────────────────────────────────────────────────

export async function resolveCollectionSource(
  source: QueueSourceRow,
  user: User,
  ceiling: number = QUEUE_SANITY_CEILING
): Promise<SourceResult> {
  const empty: SourceResult = { items: [], matchedCount: 0, truncated: false }
  if (!source.collection) return empty
  if (!(await can(user, 'read', source.collection))) return empty
  const conditions = (parseJson(source.filters) as QueueCondition[] | null) ?? []
  const stateValues = parseJson(source.state_values) as string[] | null

  // The ids query and the binding lookup only depend on source.collection, not on each
  // other's results — fire them concurrently. The binding query is intentionally kept
  // OUTSIDE the ids try/catch (its errors must still propagate/reject the call exactly
  // as before, rather than being swallowed as an empty-result); a no-op .catch is
  // attached purely to prevent an "unhandled rejection" warning in the case where the
  // ids query fails first and we return before ever awaiting bindingPromise.
  const bindingPromise = db('nivaro_workflow_bindings')
    .where({ collection: source.collection })
    .first() as Promise<{ id: number; template: string } | undefined>
  bindingPromise.catch(() => {})

  let ids: string[]
  try {
    const q = db(source.collection).select('id')
    applyQueueConditions(q as unknown as ConditionBuilder, conditions)
    const rows = (await q) as Array<{ id: string | number }>
    ids = rows.map((r) => String(r.id))
  } catch {
    return empty
  }
  if (ids.length === 0) return empty

  const binding = await bindingPromise

  type InstanceRow = {
    instance_id: string
    item: string
    current_state: string | null
    state_key: string | null
    state_color: string | null
    template: string
    started_at: Date
  }
  let instances: InstanceRow[] = []

  if (binding) {
    instances = (await selectInChunks(ids, 2000, (chunk) =>
      db('nivaro_workflow_instances as wi')
        .leftJoin('nivaro_workflow_states as s', 'wi.current_state', 's.id')
        .whereIn('wi.item', chunk)
        .where('wi.collection', source.collection)
        .orderBy('wi.started_at', 'desc')
        .select(
          'wi.id as instance_id',
          'wi.item',
          'wi.current_state',
          's.key as state_key',
          's.color as state_color',
          'wi.template',
          'wi.started_at'
        )
    )) as InstanceRow[]

    if (stateValues?.length) {
      const mode = source.state_mode === 'exclude' ? 'exclude' : 'include'
      const stateByItem = new Map<string, string | null>()
      for (const i of instances) stateByItem.set(i.item, i.state_key)
      ids = ids.filter((id) => stateFilterKeep(stateByItem.get(id) ?? null, stateValues, mode))
      const kept = new Set(ids)
      instances = instances.filter((i) => kept.has(i.item))
    }
  }

  // computeStatusBatch would otherwise re-run its own (near-identical) instances query —
  // reuse the rows we already fetched above. Only valid when `binding` is truthy (the
  // only case `instances` was ever populated); when there's no binding we pass undefined
  // so computeStatusBatch falls back to its own query, matching prior behavior exactly.
  const slaMap = ids.length
    ? await computeStatusBatch(
        source.collection,
        ids,
        binding
          ? instances.map(
              (i): SlaInstanceRow => ({
                id: i.instance_id,
                item: i.item,
                current_state: i.current_state,
                template: i.template,
                started_at: i.started_at
              })
            )
          : undefined
      )
    : {}
  ids = filterBySlaStatus(ids, slaMap, source.sla_filter)
  const afterSla = new Set(ids)
  instances = instances.filter((i) => afterSla.has(i.item))

  // Full-set light metadata BEFORE the ceiling — keeps stats exact when the
  // hydrated rows below get truncated. Skipped past BACKFILL_CEILING (memory
  // backstop); stats then fall back to the capped set.
  let idMeta: SourceIdMeta[] | undefined
  if (ids.length <= BACKFILL_CEILING) {
    const stateKeyByItem = new Map<string, string | null>()
    for (const i of instances) stateKeyByItem.set(i.item, i.state_key)
    idMeta = ids.map((id) => ({
      collection: source.collection as string,
      item_id: id,
      state: stateKeyByItem.get(id) ?? null,
      sla_status:
        (slaMap[id]?.status as 'ok' | 'warning' | 'breached' | undefined) ?? null
    }))
  }

  const sanity = applySanityCeiling(ids, ceiling)
  ids = sanity.ids
  const finalIdSet = new Set(ids)
  instances = instances.filter((i) => finalIdSet.has(i.item))

  if (ids.length === 0) {
    return { items: [], matchedCount: sanity.matchedCount, truncated: sanity.truncated, idMeta }
  }

  const stateById = new Map<string, { key: string; color: string | null }>()
  for (const inst of instances) {
    if (inst.state_key) stateById.set(inst.item, { key: inst.state_key, color: inst.state_color })
  }

  const ownerRequests = instances
    .filter((inst) => inst.current_state)
    .map((inst) => ({
      key: inst.item,
      stateId: inst.current_state as string,
      instanceId: inst.instance_id,
      collection: source.collection as string,
      itemId: inst.item
    }))

  // Labels, owner resolution, the at-risk block, and extra-field resolution are all
  // independent of each other's results — they only read `ids`/`instances`/
  // `source.collection` and are combined together in the final items.map() below. Run
  // them concurrently instead of sequentially awaiting each in turn.
  const [labels, ownersByItem, atRiskMap, extraResolved] = await Promise.all([
    source.label_template
      ? renderTemplateLabels(source.collection, ids, source.label_template)
      : getLabels(new Map([[source.collection, new Set(ids)]])),
    ownerRequests.length
      ? resolveStateOwnersBatch(ownerRequests)
      : Promise.resolve(new Map<string, ResolvedOwner[]>()),
    (async (): Promise<Record<string, { at_risk: true; rule: string; color: 'red' | 'amber' }>> => {
      const ruleRows = (await db('nivaro_at_risk_rules')
        .where({ collection: source.collection, is_active: true })
        .orderBy('id')) as AtRiskRuleRow[]
      const rules = parseActiveRules(ruleRows)
      if (!rules.length || !ids.length) return {}
      const fields = new Set<string>(['id'])
      for (const rule of rules) for (const f of referencedFields(rule.conditions)) fields.add(f)
      const riskRows = await selectInChunks(ids, 2000, (chunk) =>
        db(source.collection as string)
          .whereIn('id', chunk)
          .select([...fields])
      )
      return evaluateRows(riskRows as Record<string, unknown>[], rules)
    })(),
    (async (): Promise<{
      extraById: Map<string, Record<string, unknown>>
      extraIdsById: Map<string, Record<string, string[]>>
    }> => {
      const extraFieldPaths = (parseJson(source.extra_fields) as string[] | null) ?? []
      const extraById = new Map<string, Record<string, unknown>>()
      const extraIdsById = new Map<string, Record<string, string[]>>()
      if (!extraFieldPaths.length || !ids.length) return { extraById, extraIdsById }
      const relationsCache = new Map<string, CMSRelation[]>()
      // Parallelized across paths. relationsCache is a shared Map populated via a
      // check-then-fetch-then-set pattern — concurrent calls for the same collection may
      // each miss the cache and independently re-fetch getRelations() (redundant work,
      // not a correctness bug: every caller writes the same relations for that
      // collection, so a duplicate write is harmless).
      await Promise.all(
        extraFieldPaths.map(async (path) => {
          try {
            const segments = path.split('.')
            const valuesByRowId = await resolvePathValues(
              source.collection as string,
              ids,
              segments,
              relationsCache
            )
            for (const [rowId, pv] of valuesByRowId) {
              const extra = extraById.get(rowId) ?? {}
              extra[path] = pv.value
              extraById.set(rowId, extra)
              if (pv.ids.length > 0) {
                const idsRec = extraIdsById.get(rowId) ?? {}
                idsRec[path] = pv.ids
                extraIdsById.set(rowId, idsRec)
              }
            }
          } catch {
            // Degrade gracefully — a stale/deleted/relational field config must not
            // break the whole queue's item list, and must not prevent OTHER extra
            // field paths on the same source from resolving.
          }
        })
      )
      return { extraById, extraIdsById }
    })()
  ])

  const items = ids.map((id) => ({
    collection: source.collection as string,
    item_id: id,
    label: labels[`${source.collection}:${id}`] ?? id,
    state: stateById.get(id)?.key ?? null,
    state_color: stateById.get(id)?.color ?? null,
    owners: (ownersByItem.get(id) ?? []).map((o) => ({ id: o.id, name: userDisplayName(o) })),
    sla_status: slaMap[id]?.status ?? null,
    at_risk: !!atRiskMap[id]?.at_risk,
    aging_hours: slaMap[id]?.elapsed_hours ?? null,
    claimed_by: null,
    extra: extraResolved.extraById.get(id) ?? {},
    extra_ids: extraResolved.extraIdsById.get(id) ?? {},
    url: `/collections/${source.collection}/${id}`
  }))

  return { items, matchedCount: sanity.matchedCount, truncated: sanity.truncated, idMeta }
}

export async function resolveTasksSource(
  ceiling: number = QUEUE_SANITY_CEILING
): Promise<SourceResult> {
  const rows = (await db('nivaro_tasks as t')
    .leftJoin('nivaro_users as u', 't.assignee', 'u.id')
    .where('t.status', 'open')
    .orderBy('t.created_at', 'asc')
    .select(
      't.id',
      't.title',
      't.collection as target_collection',
      't.item as target_item',
      't.created_at',
      't.assignee',
      'u.first_name as assignee_first',
      'u.last_name as assignee_last',
      'u.email as assignee_email'
    )) as Array<{
    id: number
    title: string
    target_collection: string
    target_item: string
    created_at: Date
    assignee: string
    assignee_first: string | null
    assignee_last: string | null
    assignee_email: string
  }>

  const matchedCount = rows.length
  const truncated = matchedCount > ceiling
  const idMeta: SourceIdMeta[] = rows.map((r) => ({
    collection: 'tasks',
    item_id: String(r.id),
    state: null,
    sla_status: null
  }))
  const scoped = truncated ? rows.slice(0, ceiling) : rows

  const now = Date.now()
  const items = scoped.map((r) => ({
    collection: 'tasks',
    item_id: String(r.id),
    label: r.title,
    state: null,
    state_color: null,
    owners: [
      {
        id: r.assignee,
        name: userDisplayName({
          first_name: r.assignee_first,
          last_name: r.assignee_last,
          email: r.assignee_email
        })
      }
    ],
    sla_status: null,
    at_risk: false,
    aging_hours: Math.max(0, (now - new Date(r.created_at).getTime()) / (1000 * 60 * 60)),
    claimed_by: null,
    url: `/collections/${r.target_collection}/${r.target_item}`
  }))
  return { items, matchedCount, truncated, idMeta }
}

export async function resolveApprovalsSource(
  ceiling: number = QUEUE_SANITY_CEILING
): Promise<SourceResult> {
  const rows = (await db('nivaro_approval_instances as i')
    .where('i.status', 'pending')
    .orderBy('i.created_at', 'asc')
    .select(
      'i.id',
      'i.collection',
      'i.item',
      'i.created_at',
      'i.current_step',
      'i.chain'
    )) as Array<{
    id: number
    collection: string
    item: string
    created_at: Date
    current_step: number
    chain: number
  }>
  if (rows.length === 0) return { items: [], matchedCount: 0, truncated: false }

  const matchedCount = rows.length
  const truncated = matchedCount > ceiling
  const idMeta: SourceIdMeta[] = rows.map((r) => ({
    collection: r.collection,
    item_id: String(r.item),
    state: 'pending_approval',
    sla_status: null
  }))
  const scoped = truncated ? rows.slice(0, ceiling) : rows

  const stepRows = (await db('nivaro_approval_chain_steps')
    .whereIn('chain', [...new Set(scoped.map((r) => r.chain))])
    .select(
      'id',
      'chain',
      'step_order',
      'approver',
      'approver_role',
      'label'
    )) as ApprovalChainStep[]

  const byCollection = new Map<string, Set<string>>()
  for (const r of scoped) {
    if (!byCollection.has(r.collection)) byCollection.set(r.collection, new Set())
    byCollection.get(r.collection)!.add(r.item)
  }
  const labels = await getLabels(byCollection)

  const now = Date.now()
  const items: QueueItem[] = []
  for (const r of scoped) {
    const step = stepRows.find((s) => s.chain === r.chain && s.step_order === r.current_step)
    const approverIds = step ? await resolveStepApprovers(step) : []
    let owners: QueueOwner[] = []
    if (approverIds.length > 0) {
      const users = (await db('nivaro_users')
        .whereIn('id', approverIds)
        .select('id', 'first_name', 'last_name', 'email')) as Array<{
        id: string
        first_name: string | null
        last_name: string | null
        email: string
      }>
      owners = users.map((u) => ({ id: u.id, name: userDisplayName(u) }))
    }

    items.push({
      collection: r.collection,
      item_id: String(r.item),
      label: labels[`${r.collection}:${r.item}`] ?? String(r.item),
      state: 'pending_approval',
      state_color: null,
      owners,
      sla_status: null,
      at_risk: false,
      aging_hours: Math.max(0, (now - new Date(r.created_at).getTime()) / (1000 * 60 * 60)),
      claimed_by: null,
      url: `/collections/${r.collection}/${r.item}`
    })
  }
  return { items, matchedCount, truncated, idMeta }
}

export async function resolveOwnedByMeSource(
  userId: string,
  ceiling: number = QUEUE_SANITY_CEILING
): Promise<SourceResult> {
  const instances = (await db('nivaro_workflow_instances as wi')
    .join('nivaro_workflow_bindings as b', 'wi.collection', 'b.collection')
    .leftJoin('nivaro_workflow_states as s', 'wi.current_state', 's.id')
    .whereNotNull('wi.current_state')
    .whereNull('wi.completed_at')
    .select(
      'wi.id as instance_id',
      'wi.collection',
      'wi.item',
      'wi.current_state',
      's.key as state_key',
      's.color as state_color'
    )) as Array<{
    instance_id: string
    collection: string
    item: string
    current_state: string
    state_key: string | null
    state_color: string | null
  }>
  if (instances.length === 0) return { items: [], matchedCount: 0, truncated: false }

  // matchedCount here is the count of ALL active workflow instances scanned,
  // BEFORE the "is this user an owner" filter below is applied — so `truncated`
  // reflects global active-instance volume, not this user's own item count.
  const matchedCount = instances.length
  const truncated = matchedCount > ceiling
  const scoped = truncated ? instances.slice(0, ceiling) : instances

  const byCollection = new Map<string, Set<string>>()
  for (const inst of scoped) {
    if (!byCollection.has(inst.collection)) byCollection.set(inst.collection, new Set())
    byCollection.get(inst.collection)!.add(inst.item)
  }
  const labels = await getLabels(byCollection)

  const ownerRequests = scoped.map((inst) => ({
    key: `${inst.collection}:${inst.item}`,
    stateId: inst.current_state,
    instanceId: inst.instance_id,
    collection: inst.collection,
    itemId: inst.item
  }))
  const ownersByKey = await resolveStateOwnersBatch(ownerRequests)

  const items: QueueItem[] = []
  for (const inst of scoped) {
    const owners = ownersByKey.get(`${inst.collection}:${inst.item}`) ?? []
    if (!owners.some((o) => o.id === userId)) continue
    items.push({
      collection: inst.collection,
      item_id: inst.item,
      label: labels[`${inst.collection}:${inst.item}`] ?? inst.item,
      state: inst.state_key,
      state_color: inst.state_color,
      owners: owners.map((o) => ({ id: o.id, name: userDisplayName(o) })),
      sla_status: null,
      at_risk: false,
      aging_hours: null,
      claimed_by: null,
      url: `/collections/${inst.collection}/${inst.item}`
    })
  }
  return {
    items,
    matchedCount,
    truncated,
    // owned_by_me's matched set is defined by owner resolution, which only ran
    // for the capped scan — best-effort meta from the resolved items.
    idMeta: items.map((i) => ({
      collection: i.collection,
      item_id: i.item_id,
      state: i.state,
      sla_status: i.sla_status
    }))
  }
}

// ─── Orchestrator ───────────────────────────────────────────────────────────────

export async function fetchQueueItems(
  queueId: string,
  user: User,
  scope: QueueScope,
  options: {
    sort?: string
    filters?: Record<string, unknown>
    ceiling?: number
    page?: number
    limit?: number
  } = {}
): Promise<{
  items: QueueItem[]
  stats: QueueStats
  /** Stats over the column-filtered set; null when no column filters are active. */
  filteredStats: QueueStats | null
  availableValues: { collection: string[]; state: string[] }
  truncated: boolean
  total: number
}> {
  const queueRow = (await db('nivaro_queues').where({ id: queueId }).first()) as
    | { materialized: boolean }
    | undefined
  // When a materialized queue's ROWS must live-resolve (priority sort, sla_status
  // filter, extra.* sort/filter, owners sort), its STATS still come exact from the
  // cache — stats depend only on scope, never on the requested sort/filters, and
  // the live path's QUEUE_SANITY_CEILING would otherwise cap the stat strip at
  // 20,000 for large queues.
  let materializedStats: Promise<{
    stats: QueueStats
    availableValues: { collection: string[]; state: string[] }
  }> | null = null
  if (queueRow?.materialized) {
    const { requiresLiveResolveFallback, fetchMaterializedQueueItems, fetchMaterializedStats } =
      await import('./queue-materialization-read.js')
    if (!requiresLiveResolveFallback(options.sort ?? '', options.filters ?? {})) {
      return fetchMaterializedQueueItems(queueId, user, scope, options)
    }
    materializedStats = fetchMaterializedStats(queueId, user, scope)
    materializedStats.catch(() => {})
  }

  const sources = (await db<QueueSourceRow>('nivaro_queue_sources')
    .where({ queue_id: queueId })
    .orderBy('sort')) as QueueSourceRow[]

  const ceiling = options.ceiling ?? QUEUE_SANITY_CEILING
  const results = await Promise.all(
    sources.map((source) => {
      if (source.type === 'collection') return resolveCollectionSource(source, user, ceiling)
      if (source.type === 'tasks') return resolveTasksSource(ceiling)
      if (source.type === 'approvals') return resolveApprovalsSource(ceiling)
      return resolveOwnedByMeSource(user.id, ceiling)
    })
  )

  const truncated = results.some((r) => r.truncated)

  const summedMatchedCount = results.reduce((sum, r) => sum + r.matchedCount, 0)
  if (summedMatchedCount > PROMOTION_THRESHOLD) {
    const queue = (await db('nivaro_queues').where({ id: queueId }).first()) as
      | { materialized: boolean }
      | undefined
    if (queue && !queue.materialized) {
      const { enqueueQueueMaterializationBackfill } = await import(
        '../functions/queue-materialization-jobs.js'
      )
      await enqueueQueueMaterializationBackfill(queueId)
    }
  }

  const batches = results.map((r) => r.items)

  const merged = mergeSourceResults(batches)
  const claims = await getClaims(queueId)
  const withClaims = attachClaims(merged, claims)
  const scoped = applyScopeFilter(withClaims, scope, user.id)
  const availableValues = computeAvailableValues(scoped)
  const filtered = options.filters ? applyColumnFilters(scoped, options.filters) : scoped
  const sorted = options.sort ? sortItems(filtered, options.sort) : filtered
  // Each resolver's `matchedCount` feeds only the `truncated` flag above — it is
  // intentionally NOT summed into stats.total, since that would double-count
  // items that appear in more than one source and would ignore scope filtering.
  // computeStats(scoped) counts the final deduped, scope-filtered set instead,
  // which is more accurate than a raw per-source sum.
  const { items: paged, total } = paginateItems(sorted, options.page, options.limit)
  // Prefer exact cache stats for a materialized queue on the live-fallback path —
  // fall back to live-computed stats if the cache read failed for any reason.
  const exact = materializedStats ? await materializedStats.catch(() => null) : null
  // Live-path exact stats: when hydrated rows were truncated by the sanity
  // ceiling, recompute total/by_state/sla from the resolvers' full id metadata.
  // Scope 'all' only — other scopes filter by owners, which are resolved only
  // for the hydrated subset. Sources missing idMeta contribute their hydrated
  // items so totals never undercount what is actually shown.
  const liveExact =
    !exact && truncated && scope === 'all'
      ? computeStatsFromIdMeta(
          results.map(
            (r) =>
              r.idMeta ??
              r.items.map((i) => ({
                collection: i.collection,
                item_id: i.item_id,
                state: i.state,
                sla_status: i.sla_status
              }))
          ),
          scoped
        )
      : null
  return {
    items: paged,
    stats: exact?.stats ?? liveExact ?? computeStats(scoped),
    filteredStats: hasActiveColumnFilters(options.filters) ? computeStats(filtered) : null,
    availableValues: exact?.availableValues ?? availableValues,
    truncated,
    total
  }
}

export async function getWipLimits(ownerIds: string[]): Promise<Map<string, number>> {
  if (ownerIds.length === 0) return new Map()
  const rows = (await db('nivaro_pipeline_owner_group_users as gu')
    .join('nivaro_pipeline_owner_groups as g', 'gu.group', 'g.id')
    .whereIn('gu.user', ownerIds)
    .whereNotNull('g.max_wip')
    .select('gu.user', 'g.max_wip')) as Array<{ user: string; max_wip: number }>

  const out = new Map<string, number>()
  for (const r of rows) {
    const current = out.get(r.user)
    if (current === undefined || r.max_wip < current) out.set(r.user, r.max_wip)
  }
  return out
}

export async function fetchQueueWorkload(queueId: string, user: User): Promise<WorkloadRow[]> {
  const { items } = await fetchQueueItems(queueId, user, 'all')
  const groups = groupByOwner(items)
  const ownerIds = [...groups.values()].map((g) => g.owner?.id).filter((id): id is string => !!id)
  const limits = await getWipLimits(ownerIds)

  return [...groups.values()].map((g) => ({
    owner: g.owner,
    count: g.count,
    max_wip: g.owner ? (limits.get(g.owner.id) ?? null) : null
  }))
}
