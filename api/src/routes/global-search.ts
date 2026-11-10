import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import { requireAuth } from '../middleware/authenticate.js'
import { tenantState } from '../services/ai-tenant-state.js'
import { getCollection, getFields } from '../services/collections.js'
import { readItems } from '../services/items.js'
import { getAllowedFields } from '../services/permissions.js'
import { withReadGate } from '../services/read-gate.js'
import { fallbackDisplayRef, recordDisplayRefs } from '../services/record-display-ref.js'
import { safeRecordLabel } from '../services/record-label-fallback.js'
import { MAX_LABEL_REFS, recordLabelsAsViewer } from '../services/record-labels-as-viewer.js'
import {
  type AccessClause,
  andAccess,
  onIdExpr,
  searchAccessClause,
  searchAccessClauses
} from '../services/search-access.js'
import { SearchBudget } from '../services/search-budget.js'
import {
  labelSearchFieldsOf,
  parseSearchFields,
  searchGroupDetailOf,
  searchGroupOf,
  searchInternalFieldsOf
} from '../services/search-fields.js'
import { ftsColumns, ftsCondition, searchAnswerCache } from '../services/search-fts.js'
import {
  fastLike,
  onMssql,
  type TextKind,
  textKindOf,
  typedEquals,
  withFastContains
} from '../services/search-like.js'
import { buildSearchLinked } from '../services/search-linked.js'
import { buildSearchPreview, previewValue } from '../services/search-preview.js'
import {
  type FieldMeta,
  type FilterChip,
  type FilterPlan,
  hasFilterTokens,
  type ParsedQuery,
  PEOPLE_SCOPE,
  parseSearchQuery,
  planFilters
} from '../services/search-query.js'
import {
  FUZZY_MIN_SIMILARITY,
  fuzzyChunks,
  isIdColumn,
  isNumericIdColumn,
  looksLikeId,
  type MatchTier,
  matchTier,
  rankHits,
  scoreHit,
  similarity,
  wantsFuzzy
} from '../services/search-rank.js'
import {
  createSavedSearch,
  deleteSavedSearch,
  listSavedSearches,
  SavedSearchError
} from '../services/search-saved.js'
import { loadSearchScopes } from '../services/search-scopes.js'
import {
  hitKey,
  learnedOpens,
  ownedAmong,
  recentOpens,
  recordClick
} from '../services/search-signals.js'
import { searchPhrases } from '../services/search-synonyms.js'
import { systemReadableColumns } from '../services/system-collections.js'
import { applyDirectoryListingRules } from '../services/user-directory-cols.js'
import type { CMSField, Policy, Role, User } from '../types.js'

// ─── Static admin page registry ───────────────────────────────────────────────

const ADMIN_PAGES: { label: string; path: string; keywords?: string }[] = [
  { label: 'Overview', path: '/', keywords: 'home dashboard' },
  { label: 'Dashboards', path: '/dashboards', keywords: 'kpi widgets' },
  { label: 'Collections', path: '/collections', keywords: 'content data items' },
  { label: 'Data Model', path: '/data-model', keywords: 'schema fields tables' },
  { label: 'Files', path: '/files', keywords: 'uploads media' },
  { label: 'Hierarchies', path: '/hierarchies', keywords: 'tree levels' },
  { label: 'Record Templates', path: '/record-templates' },
  { label: 'Collection Presets', path: '/collection-presets' },
  { label: 'Users', path: '/users', keywords: 'people accounts' },
  { label: 'Roles', path: '/roles', keywords: 'permissions policies rbac' },
  { label: 'Workspaces', path: '/workspaces' },
  { label: 'Pipelines', path: '/pipelines', keywords: 'owner matrix' },
  { label: 'Flows', path: '/flows', keywords: 'automation' },
  { label: 'Workflows', path: '/workflows', keywords: 'state machine' },
  { label: 'Webhooks', path: '/webhooks' },
  { label: 'Rules', path: '/rules', keywords: 'automation conditions' },
  { label: 'Blackout Dates', path: '/blackout-dates' },
  { label: 'Scheduled Changes', path: '/scheduled-changes' },
  { label: 'Virtual Collections', path: '/virtual-collections' },
  { label: 'External APIs', path: '/external-apis', keywords: 'integrations' },
  { label: 'GraphQL Explorer', path: '/graphql', keywords: 'graphiql' },
  { label: 'Custom Queries', path: '/custom-queries', keywords: 'sql' },
  { label: 'Extensions', path: '/extensions', keywords: 'plugins' },
  { label: 'Analytics', path: '/analytics' },
  { label: 'Presence', path: '/presence' },
  { label: 'Docs', path: '/docs', keywords: 'documentation reference' },
  { label: 'API Docs', path: '/api-docs', keywords: 'rest reference' },
  { label: 'Settings', path: '/settings', keywords: 'configuration ai key' },
  { label: 'Activity', path: '/activity', keywords: 'audit log' },
  { label: 'Reports', path: '/reports', keywords: 'audit' },
  { label: 'Alerts', path: '/alerts', keywords: 'thresholds' },
  { label: 'SLA Rules', path: '/sla-rules' },
  { label: 'Field Watches', path: '/field-watches', keywords: 'changelog' },
  { label: 'Notification Subscriptions', path: '/notification-subscriptions' },
  { label: 'Imports', path: '/imports', keywords: 'csv upload' },
  { label: 'Submission Forms', path: '/submission-forms', keywords: 'public forms' },
  { label: 'Schema Snapshot', path: '/schema-snapshot' },
  { label: 'Profile', path: '/profile', keywords: 'account token' }
]

const QUICK_ACTIONS: { label: string; path: string; keywords?: string }[] = [
  { label: 'New Import', path: '/imports/new', keywords: 'csv upload data' },
  { label: 'New Alert', path: '/alerts/new', keywords: 'threshold' },
  { label: 'Create Workspace', path: '/workspaces', keywords: 'new workspace' },
  { label: 'Open Settings', path: '/settings', keywords: 'configure' }
]

// ─── Field selection ──────────────────────────────────────────────────────────

const PREFERRED_TEXT_FIELDS = ['name', 'title', 'label', 'email', 'subject']

interface FieldRow {
  collection: string
  field: string
  type: string
  hidden: boolean | number
  sort: number | null
  label?: string | null
}

/** Pick the text-ish fields to search per collection: preferred names first, else first 2 string fields. */
function pickSearchFields(fields: FieldRow[]): string[] {
  const textish = fields.filter((f) => ['string', 'text'].includes(f.type) && !f.hidden)
  const preferred = textish.filter((f) => PREFERRED_TEXT_FIELDS.includes(f.field.toLowerCase()))
  if (preferred.length > 0) return preferred.slice(0, 2).map((f) => f.field)
  return textish
    .sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999))
    .slice(0, 2)
    .map((f) => f.field)
}

// ─── Record search plan ───────────────────────────────────────────────────────
//
// One UNION ALL round trip over each searchable collection's human columns
// (display_template plain tokens, name/title/label/subject, and string-typed
// *_id business identifiers like order_id), then the candidate ids are
// CONFIRMED through readItems per collection so RBAC, row-level security and
// User Scopes all apply — the raw scan can never leak a row the items API
// would refuse. Replaces the old first-10-collections per-table search, which
// missed both most collections and every human-id column.
//
// Search program 2026-10-28 adds, on the same plan: an exact-id pass (an id-ish
// query equal to a business id column → `data.exact`, ranked first), a typo pass
// when little matched, prefix scopes and field filters (services/search-query.ts,
// filters go through the items service as the caller), and ranking signals
// (services/search-rank.ts + search-signals.ts) that only ever reorder hits the
// caller already read.

interface PlanEntry {
  collection: string
  display_name: string | null
  columns: string[]
  /** The columns its label shows (display-template fields, else the first search
   *  column), plus `browser_config.label_search_fields`: what a labels-only
   *  search (`labels=1`) matches. */
  labelColumns: string[]
  /** The `label_search_fields` among labelColumns: a labels-only hit through one
   *  of them is kept although the label does not show the phrase. */
  labelSearch: string[]
  /** String columns holding business ids (`workflow_id`, `mwf_id`, `po_number`). */
  idColumns: string[]
  /** Numeric columns holding quoted numbers (`po_number`) — digits-only queries. */
  numIdColumns: string[]
  template: string | null
  /** Partition-stat row count — what a contains-LIKE over it costs. */
  rows: number
  /** false: over ROW_BUDGET or no text columns — never scanned, but still a scope
   *  target (filters through the items service, `id` equality). */
  textSearchable: boolean
  /** Each string column's text kind (nvarchar vs varchar) — how its LIKE is bound
   *  (services/search-like.ts). Missing = plain LIKE. */
  kinds?: Record<string, TextKind>
  /** Columns that lead an index: an exact id there is a seek. */
  indexed?: string[]
  /** A table over ROW_BUDGET: its id columns are index-led only (bigTableSeekColumns) —
   *  exact and prefix seeks, never a scan. */
  seekOnly?: boolean
  /** `browser_config.search_group_by` / `search_detail` (services/search-fields.ts). */
  groupBy?: string | null
  detail?: string[]
  /** `browser_config.search_group_detail`: a grouped row's second line (`vendor.name`). */
  groupDetail?: string[]
  /** `browser_config.search_internal_fields`: another system's ids — equality only,
   *  never shown (army 11 a3 G). */
  internal?: string[]
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const NAMEISH = ['name', 'title', 'label', 'subject']
const MAX_COLS_PER_COLLECTION = 3
const MAX_ID_COLS = 4
const MAX_NUM_ID_COLS = 2
const MAX_LABEL_SEARCH = 4
const PER_COLLECTION = 8
const RECORD_CAP = 30
// A contains-LIKE is a table scan; multi-million-row tables (invoices 2.7M,
// legacy logs 1.6M) each cost 4-13s and blow the 15s statement timeout for
// the whole union. Tables above this row count are excluded from omnisearch —
// the searchable set stays every collection a person actually types names
// and ids from (workflows, IRs, projects, vendors, units, lines).
const ROW_BUDGET = 500_000
// The typo pass runs several LIKEs per row: only on the smaller tables.
const FUZZY_ROW_BUDGET = 200_000
const FUZZY_PER_COLLECTION = 4
const FILTER_COLLECTIONS = 12

/**
 * A table over ROW_BUDGET is never scanned, but an id typed exactly (or its start)
 * is still a single index seek there (army 8 b07/b14/b16: invoice numbers —
 * "11006855426ADJ", "130115" — found nothing because invoices, 2.7M rows, sat out
 * of search entirely). Its seek columns: the string id columns (`number`,
 * `invoice_id`) and `browser_config.search_fields` string columns that LEAD an
 * index — never a column a statement would have to scan. Numeric columns only when
 * search_fields names them (a big table's `line_item_number` would match "12" on
 * thousands of rows). Exported for tests.
 */
export function bigTableSeekColumns(
  stringCols: Iterable<string>,
  numericCols: Iterable<string>,
  indexed: Iterable<string>,
  searchFields: string[] | null
): { cols: string[]; nums: string[] } {
  const leads = new Set(indexed)
  const named = new Set(searchFields ?? [])
  const cols = [...stringCols]
    .filter((c) => IDENT_RE.test(c) && leads.has(c) && (isIdColumn(c) || named.has(c)))
    .sort()
    .slice(0, MAX_ID_COLS)
  const nums = [...numericCols]
    .filter((c) => IDENT_RE.test(c) && leads.has(c) && named.has(c))
    .sort()
    .slice(0, MAX_NUM_ID_COLS)
  return { cols, nums }
}

/** `browser_config.label_search_fields` (search program item 23) through the one
 *  parser (services/search-fields.ts): identifier names only, deduped, capped.
 *  Never widens past what the caller may read — searchColumns intersects with
 *  their field list like any column. */
export function parseLabelSearchFields(browserConfig: unknown): string[] {
  const names = (labelSearchFieldsOf(browserConfig) ?? []).filter((v) => IDENT_RE.test(v))
  return [...new Set(names)].slice(0, MAX_LABEL_SEARCH)
}

/** Each table's columns that lead an (unfiltered, enabled) index. Empty off SQL Server. */
async function indexLeads(): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  try {
    const rows = (await db.raw(`
      select t.name as table_name, c.name as column_name
      from sys.index_columns ic
      join sys.indexes i on i.object_id = ic.object_id and i.index_id = ic.index_id
      join sys.tables t on t.object_id = ic.object_id
      join sys.columns c on c.object_id = ic.object_id and c.column_id = ic.column_id
      where ic.key_ordinal = 1 and i.is_disabled = 0 and i.has_filter = 0
    `)) as Array<{ table_name: string; column_name: string }>
    for (const r of rows ?? []) {
      const set = out.get(r.table_name) ?? new Set<string>()
      set.add(r.column_name)
      out.set(r.table_name, set)
    }
  } catch {
    /* other dialects: no seeks claimed */
  }
  return out
}

// One plan per tenant: in cloud mode one process serves many tenant databases.
const planCacheOf = tenantState(() => ({
  value: null as { at: number; plan: PlanEntry[] } | null,
  building: null as Promise<PlanEntry[]> | null
}))
/** A plan younger than this is used as is. */
const PLAN_FRESH_MS = 60_000
/** A plan younger than this still answers at once while a rebuild runs behind it. */
const PLAN_STALE_MS = 30 * 60_000

/**
 * The search plan, rebuilt once a minute — but never inside a search's wait once one
 * exists (army 7 b16 N1): on a quiet day every search came more than a minute after the
 * last, so each paid the six metadata reads (information_schema over every table) before
 * its own statements, and on a cold staging that ate the budget. A stale plan (≤30 min)
 * answers now and one rebuild (single-flight, background pool) lands for the next search.
 */
async function buildSearchPlan(): Promise<PlanEntry[]> {
  const state = planCacheOf()
  const cached = state.value
  const age = cached ? Date.now() - cached.at : Number.POSITIVE_INFINITY
  if (cached && age < PLAN_FRESH_MS) return cached.plan
  const stale = cached != null && age < PLAN_STALE_MS
  if (!state.building) {
    const load = () => loadSearchPlan()
    const building = (stale ? runInBackgroundPool(load) : load()).then((plan) => {
      state.value = { at: Date.now(), plan }
      return plan
    })
    state.building = building
    void building
      .finally(() => {
        if (state.building === building) state.building = null
      })
      .catch(() => {})
  }
  if (stale && cached) return cached.plan
  return state.building
}

async function loadSearchPlan(): Promise<PlanEntry[]> {
  const [collections, stringCols, numericCols, relations, idTables, rowCounts, leads] =
    await Promise.all([
      db('nivaro_collections')
        .whereNot('collection', 'like', 'nivaro\\_%')
        .whereNot('collection', 'like', 'directus\\_%')
        .where((qb) => void qb.where('is_virtual', 0).orWhereNull('is_virtual'))
        .select('collection', 'display_name', 'display_template', 'browser_config') as Promise<
        Array<{
          collection: string
          display_name: string | null
          display_template: string | null
          browser_config: unknown
        }>
      >,
      db.raw(`
      select table_name, column_name, data_type from information_schema.columns
      where data_type in ('nvarchar', 'varchar', 'char', 'nchar')
        and (character_maximum_length between 1 and 2000 or character_maximum_length = -1)
    `) as Promise<Array<{ table_name: string; column_name: string; data_type: string }>>,
      // Quoted numbers stored as numbers (po_number int) — name-filtered in JS.
      db.raw(`
      select table_name, column_name from information_schema.columns
      where data_type in ('int', 'bigint', 'numeric', 'decimal')
        and (column_name like '%number' or column_name like '%[_]num' or column_name like '%[_]no')
    `) as Promise<Array<{ table_name: string; column_name: string }>>,
      // Junction collections carry no human labels — searching them is noise.
      db('nivaro_relations').whereNotNull('junction_field').select('many_collection') as Promise<
        Array<{ many_collection: string }>
      >,
      // Registry junk exists (sysdiagrams made it into nivaro_collections) —
      // every union arm selects `id`, so a table without one breaks the batch.
      db.raw(
        `select table_name from information_schema.columns where column_name = 'id'`
      ) as Promise<Array<{ table_name: string }>>,
      // Row counts from partition stats — one query for every table (the
      // config-diff inventory precedent; serial COUNT(*)s took seconds).
      db.raw(`
      select tb.name as table_name, sum(p.rows) as row_count
      from sys.partitions p join sys.tables tb on tb.object_id = p.object_id
      where p.index_id in (0, 1) group by tb.name
    `) as Promise<Array<{ table_name: string; row_count: number | string }>>,
      // Columns leading an index (an exact id there is a seek, not a scan).
      indexLeads()
    ])

  const junctions = new Set(relations.map((r) => r.many_collection))
  const hasId = new Set(idTables.map((t) => t.table_name))
  const rowsByTable = new Map(rowCounts.map((r) => [r.table_name, Number(r.row_count)]))
  const group = (rows: Array<{ table_name: string; column_name: string }>) => {
    const by = new Map<string, Set<string>>()
    for (const c of rows) {
      const set = by.get(c.table_name) ?? new Set<string>()
      set.add(c.column_name)
      by.set(c.table_name, set)
    }
    return by
  }
  const colsByTable = group(stringCols)
  const numsByTable = group(numericCols)
  const kindOf = new Map(
    stringCols.map((c) => [`${c.table_name}.${c.column_name}`, textKindOf(c.data_type)])
  )

  const plan: PlanEntry[] = []
  for (const col of collections) {
    if (junctions.has(col.collection)) continue
    if (!IDENT_RE.test(col.collection)) continue
    if (!hasId.has(col.collection)) continue
    const rows = rowsByTable.get(col.collection) ?? 0
    const available = colsByTable.get(col.collection) ?? new Set<string>()

    const picked: string[] = []
    for (const m of (col.display_template ?? '').matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
      if (available.has(m[1]) && !picked.includes(m[1])) picked.push(m[1])
    }
    const fromTemplate = picked.filter((c) => IDENT_RE.test(c))
    for (const n of NAMEISH) if (available.has(n) && !picked.includes(n)) picked.push(n)
    // String-typed *_id columns are business identifiers (order_id,
    // project_id, request_id) — FK columns are ints/uuids.
    for (const c of available) {
      if (c.endsWith('_id') && c !== 'id' && !picked.includes(c)) picked.push(c)
    }
    // Another system's ids (search_internal_fields) are never contains-matched.
    const internal = searchInternalFieldsOf(col.browser_config)
    const columns = picked
      .filter((c) => IDENT_RE.test(c) && !internal.includes(c))
      .slice(0, MAX_COLS_PER_COLLECTION)
    const labelSearch = parseLabelSearchFields(col.browser_config).filter((c) => available.has(c))
    // A template that shows only non-text fields has no label to match: the
    // collection sits out of a labels-only search. No template: the label is the
    // first search column.
    const baseLabel = col.display_template?.trim() ? fromTemplate : columns.slice(0, 1)
    const idColumns = [...available]
      .filter((c) => IDENT_RE.test(c) && isIdColumn(c))
      .sort()
      .slice(0, MAX_ID_COLS)
    const numIdColumns = [...(numsByTable.get(col.collection) ?? [])]
      .filter((c) => IDENT_RE.test(c) && isNumericIdColumn(c))
      .sort()
      .slice(0, MAX_NUM_ID_COLS)
    const textSearchable = rows <= ROW_BUDGET && columns.length > 0
    const kinds: Record<string, TextKind> = {}
    for (const c of available) kinds[c] = kindOf.get(`${col.collection}.${c}`) ?? 'other'
    const small = rows <= ROW_BUDGET
    const seekOnly = small
      ? null
      : bigTableSeekColumns(
          available,
          numsByTable.get(col.collection) ?? [],
          leads.get(col.collection) ?? [],
          parseSearchFields(col.browser_config)
        )
    plan.push({
      collection: col.collection,
      display_name: col.display_name,
      columns: small ? columns : [],
      labelColumns: small
        ? [...new Set([...baseLabel, ...labelSearch])].filter((c) => !internal.includes(c))
        : [],
      labelSearch,
      idColumns: seekOnly ? seekOnly.cols : idColumns,
      numIdColumns: seekOnly ? seekOnly.nums : numIdColumns,
      ...(seekOnly ? { seekOnly: true } : {}),
      template: col.display_template,
      ...searchGroupPlan(col.browser_config),
      ...(internal.length ? { internal } : {}),
      rows,
      textSearchable,
      kinds,
      indexed: [...(leads.get(col.collection) ?? [])]
    })
  }
  return plan
}

/** Statements one search runs at a time (the rest queue for a slot). */
const SEARCH_CONCURRENCY = 4
/** A search's time budget: parts still running past it are cut and named in
 *  `partial`. SEARCH_BUDGET_MS overrides it (300 ms – 15 s). */
const DEFAULT_SEARCH_BUDGET_MS = 1_800

export function searchBudgetMs(env: string | undefined = process.env.SEARCH_BUDGET_MS): number {
  const n = Number(env)
  if (!env || !Number.isFinite(n)) return DEFAULT_SEARCH_BUDGET_MS
  return Math.min(15_000, Math.max(300, Math.floor(n)))
}

function escapeLike(v: string): string {
  return v.replace(/[\\%_[]/g, (m) => `\\${m}`)
}

export type RecordHit = {
  collection: string
  display_name: string | null
  id: unknown
  label: string
  snippet: string
  /** The field the match was found in — always one the caller may read. */
  matched_field?: string
  matched_label?: string
  /** Its value as the caller read it, ≤80 chars. */
  matched_value?: string
  exact?: boolean
  score?: number
  /** The caller created it, owns it, or opened it from search lately. */
  mine?: boolean
  updated_at?: string
  /** The record's readable id (#776) as the caller reads it — absent when it has none. */
  friendly_id?: string
  /** How many matching records share this hit's `search_group_by` value (≥2): shown as
   *  this one row — an invoice's lines (army 9 b07/b14/b16). Palette answer only. */
  group_size?: number
  /** The collection's hits were capped: the group may hold more than `group_size`. */
  group_more?: boolean
}

/** A hit while it is being ranked. */
interface Found extends RecordHit {
  tier: MatchTier
  similarity?: number
  createdBy?: string | null
}

/** The columns a search matches: every search column, or (labels-only) just the ones
 *  the record's label shows — so every hit visibly contains what was typed. */
export function searchColumns(
  p: Pick<PlanEntry, 'columns' | 'labelColumns'>,
  labelsOnly: boolean,
  allowed?: string[] | null
): string[] {
  const cols = labelsOnly ? p.labelColumns : p.columns
  return readableOnly(cols, allowed)
}

/** A column the caller may not read is never matched: a hit (or a count) found
 *  through it would say what it holds. null = every field. */
function readableOnly(cols: string[], allowed?: string[] | null): string[] {
  return allowed == null || allowed.includes('*') ? cols : cols.filter((c) => allowed.includes(c))
}

/** Each plan collection's readable fields for the caller (null = all). */
async function allowedByCollection(
  user: User,
  plan: Array<{ collection: string }>
): Promise<Map<string, string[] | null>> {
  const out = new Map<string, string[] | null>()
  await Promise.all(
    plan.map(async (p) => {
      out.set(p.collection, await getAllowedFields(user, 'read', p.collection).catch(() => []))
    })
  )
  return out
}

/** A hit's label: the collection's display template over the row, else the matched
 *  text — never the primary key: a pk-only label falls back to a business id column
 *  on the caller's row, else the collection's display name (record-label-fallback.ts). */
function hitLabel(
  p: Pick<PlanEntry, 'collection' | 'display_name' | 'template'> &
    Partial<Pick<PlanEntry, 'columns' | 'idColumns'>>,
  item: Record<string, unknown>,
  matched: string
): string {
  let label = matched
  if (p?.template) {
    const rendered = p.template.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_m, tok: string) => {
      const v = item[tok.split('.')[0]]
      return v == null || typeof v === 'object' ? '' : String(v)
    })
    if (rendered.trim()) label = rendered.trim()
  }
  return safeRecordLabel(label, {
    collection: p.collection,
    id: item.id,
    display_name: p.display_name,
    row: item,
    columns: [...(p.idColumns ?? []), ...(p.columns ?? [])]
  }).slice(0, 80)
}

/** The first plan column holding a value, for a hit found by the items service
 *  ('' when none does — hitLabel then falls back, never to the pk). */
function matchedText(p: PlanEntry, item: Record<string, unknown>, cols = p.columns): string {
  for (const c of cols) {
    if (c === 'id') continue
    const v = item[c]
    if (v != null && typeof v !== 'object' && String(v).trim()) return String(v)
  }
  return ''
}

const UPDATED_COLS = ['date_updated', 'updated_at', 'modified_at', 'date_modified']
const CREATED_BY_COLS = ['user_created', 'created_by']

type LabelOf = (collection: string, field: string) => string

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

function fieldLabelMap(rows: Array<{ collection: string; field: string; label?: string | null }>) {
  const m = new Map<string, string>()
  for (const r of rows) {
    const l = String(r.label ?? '').trim()
    if (l) m.set(`${r.collection}.${r.field}`, l)
  }
  return (collection: string, field: string) =>
    m.get(`${collection}.${field}`) ?? (field === 'id' ? 'ID' : titleCase(field))
}

/**
 * One row as the caller read it → a hit, or null when none of `cols` holds the
 * phrase (or a synonym form). Label, snippet and matched value come from the
 * caller's row, never the raw scan: a column they may not read is absent there.
 * Exported for tests.
 */
export function toHit(
  p: Pick<PlanEntry, 'collection' | 'display_name' | 'template'>,
  item: Record<string, unknown>,
  cols: string[],
  forms: string[],
  labelOf: LabelOf
): Found | null {
  let best: { col: string; value: string; tier: MatchTier } | null = null
  const order: MatchTier[] = ['equal', 'prefix', 'word', 'contains']
  for (const c of cols) {
    const t = matchTier(item[c], forms)
    if (t && (!best || order.indexOf(t) < order.indexOf(best.tier)))
      best = { col: c, value: String(item[c]), tier: t }
  }
  if (!best) return null
  return withRowFacts(
    {
      collection: p.collection,
      display_name: p.display_name ?? null,
      id: item.id,
      label: hitLabel(p, item, best.value),
      snippet: best.value.slice(0, 120),
      matched_field: best.col,
      matched_label: labelOf(p.collection, best.col),
      matched_value: best.value.slice(0, 80),
      tier: best.tier
    },
    item
  )
}

/** A hit matched through another system's id (search_internal_fields) shows its label,
 *  never that id (army 11 a3 G: "Invoice Id: 100200585-131222-…"). Exported for tests. */
export function hideInternalMatch<
  H extends {
    label: string
    snippet: string
    matched_field?: string
    matched_label?: string
    matched_value?: string
  }
>(h: H, p: Pick<PlanEntry, 'internal'>): H {
  if (!h.matched_field || !(p.internal ?? []).includes(h.matched_field)) return h
  const { matched_label: _l, matched_value: _v, ...rest } = h
  return { ...rest, snippet: h.label } as H
}

function withRowFacts(h: Found, item: Record<string, unknown>): Found {
  for (const c of UPDATED_COLS) {
    const v = item[c]
    if (v != null && typeof v !== 'object') {
      h.updated_at = String(v)
      break
    }
    if (v instanceof Date) {
      h.updated_at = v.toISOString()
      break
    }
  }
  for (const c of CREATED_BY_COLS) {
    const v = item[c]
    if (v != null && typeof v !== 'object') {
      h.createdBy = String(v)
      break
    }
  }
  return h
}

/** Higher id first (numeric ids numerically); the order ties keep (rankHits is stable). */
export function newestFirst(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const x = Number(a.id)
  const y = Number(b.id)
  if (Number.isFinite(x) && Number.isFinite(y)) return y - x
  return String(b.id).localeCompare(String(a.id))
}

/** Candidate ids per collection → the rows the caller may read (RBAC, row filters,
 *  User Scopes), one readItems per collection. Unreadable = nothing. */
async function confirmRows(
  user: User,
  byCollection: Map<string, string[]>
): Promise<Map<string, Array<Record<string, unknown>>>> {
  const out = new Map<string, Array<Record<string, unknown>>>()
  await Promise.all(
    [...byCollection.entries()].map(async ([collection, ids]) => {
      if (ids.length === 0) return
      try {
        const { data } = await readItems(user, collection, {
          filter: { id: { _in: ids } },
          limit: ids.length,
          count: false
        })
        out.set(collection, data as Array<Record<string, unknown>>)
      } catch {
        /* collection unreadable for this user — drop silently */
      }
    })
  )
  return out
}

function groupCandidates(
  rows: Array<{ c: string; id: string }>,
  cap: number | ((collection: string) => number)
) {
  const by = new Map<string, string[]>()
  const capOf = typeof cap === 'number' ? () => cap : cap
  for (const r of rows) {
    const list = by.get(r.c) ?? []
    if (list.length < capOf(r.c) && !list.includes(r.id)) list.push(r.id)
    by.set(r.c, list)
  }
  return by
}

/** Tables below this many rows are searched together in one statement. */
const SMALL_TABLE_ROWS = 20_000
/** Bindings per batched statement (SQL Server takes ~2100). */
const MAX_BATCH_BINDINGS = 1800

interface Arm {
  collection: string
  rows: number
  sql: string
  bindings: unknown[]
}

const kindOfCol = (p: Pick<PlanEntry, 'kinds'>, c: string): TextKind => p.kinds?.[c] ?? 'other'

/**
 * One collection's arm of the text pass: TOP n ids where a search column contains the
 * phrase (or, with synonyms, any `nvr_syn` form), best matches first. Plain phrases
 * bind each column's LIKE in its cheap form (services/search-like.ts). Exported for tests.
 */
export function textArm(
  p: Pick<PlanEntry, 'collection' | 'kinds'>,
  cols: string[],
  q: string,
  likes: string[],
  ft: { cols: string[]; cond: { sql: string; bindings: string[] } } | null,
  perCollection: number,
  mssql = onMssql(),
  /** The caller's read gate (services/search-access.ts): judged before the TOP, so
   *  the n rows taken are rows this person may read (army 11 Q2-3). */
  access: AccessClause | null = null
): { sql: string; bindings: unknown[] } {
  const bindings: unknown[] = []
  let wheres: string
  if (likes.length > 1) {
    wheres = `EXISTS (SELECT 1 FROM nvr_syn s WHERE ${cols.map((c) => `[${c}] LIKE s.p ESCAPE '\\'`).join(' OR ')})`
  } else {
    const likeCols = ft ? cols.filter((c) => !ft.cols.includes(c)) : cols
    const parts: string[] = []
    if (ft) {
      parts.push(ft.cond.sql)
      bindings.push(...ft.cond.bindings)
    }
    for (const c of likeCols) {
      const l = fastLike(`[${c}]`, likes[0], kindOfCol(p, c), { escape: '\\', mssql })
      parts.push(l.sql)
      bindings.push(...l.bindings)
    }
    wheres = parts.join(' OR ')
  }
  // Best matches first within each collection (army 2026-10-25: an exact
  // name came back nowhere because TOP took an arbitrary five): a column
  // equal to the phrase, then one starting with it, then the newest.
  const eq = cols.map((c) => typedEquals(`[${c}]`, q, kindOfCol(p, c), { indexed: false, mssql }))
  const pre = cols.map((c) =>
    fastLike(`[${c}]`, `${escapeLike(q)}%`, kindOfCol(p, c), { escape: '\\', mssql })
  )
  const gate = andAccess(access)
  bindings.push(...gate.bindings)
  const rank = `CASE WHEN ${eq.map((e) => e.sql).join(' OR ')} THEN 0 WHEN ${pre.map((e) => e.sql).join(' OR ')} THEN 1 ELSE 2 END`
  for (const e of [...eq, ...pre]) bindings.push(...e.bindings)
  const where = gate.sql ? `(${wheres})${gate.sql}` : wheres
  return {
    sql: `SELECT * FROM (SELECT TOP ${perCollection} '${p.collection}' AS c, CAST(id AS nvarchar(64)) AS id FROM [${p.collection}] WHERE ${where} ORDER BY ${rank}, id DESC) AS [s_${p.collection}]`,
    bindings
  }
}

/** Group arms into statements: each big table alone, the small ones packed together
 *  (within the binding cap). Exported for tests. */
export function packArms<A extends { rows: number; bindings: unknown[] }>(
  arms: A[],
  reserved = 0
): A[][] {
  const out: A[][] = []
  let small: A[] = []
  let used = reserved
  for (const a of [...arms].sort((x, y) => y.rows - x.rows)) {
    if (a.rows >= SMALL_TABLE_ROWS) {
      out.push([a])
      continue
    }
    if (small.length && used + a.bindings.length > MAX_BATCH_BINDINGS) {
      out.push(small)
      small = []
      used = reserved
    }
    small.push(a)
    used += a.bindings.length
  }
  if (small.length) out.push(small)
  return out
}

/** Budget priorities (services/search-budget.ts): exact ids before record scans before
 *  the extra kinds (notes, files…), which run at the default 0. */
const EXACT_PRIORITY = 2
const RECORD_PRIORITY = 1

/**
 * The order groups ask for a slot in: the packed small tables first, then the big
 * tables smallest first. Under a deadline the cheap statements finish and answer; the
 * old biggest-first order spent every slot on the slowest scans and cut the small
 * tables (projects, vendors) that hold most of what people type. Exported for tests.
 */
export function cheapestFirst<A extends { rows: number }>(groups: A[][]): A[][] {
  const cost = (g: A[]) => (g.length > 1 ? 0 : (g[0]?.rows ?? 0))
  return [...groups].sort((a, b) => cost(a) - cost(b))
}

/**
 * Run arms under the search's budget: one statement per group (packArms), at most the
 * budget's concurrency at a time, each cancelled on the server at the deadline. A
 * group that fails (a stale plan: dropped table or column) drops the plan cache; one
 * that runs out of time is recorded in the budget (`timedOut`) under its collections.
 */
async function runArms(
  budget: SearchBudget,
  arms: Arm[],
  prefix: { sql: string; bindings: unknown[] } | null = null,
  priority = RECORD_PRIORITY
): Promise<Array<{ c: string; id: string }>> {
  const groups = cheapestFirst(packArms(arms, prefix?.bindings.length ?? 0))
  const results = await Promise.all(
    groups.map((g) => {
      // `partial` names a big table; the small ones together are one entry.
      const label = g.length === 1 ? g[0].collection : 'small tables'
      const sql = (prefix?.sql ?? '') + g.map((a) => a.sql).join(' UNION ALL ')
      const bindings = [...(prefix?.bindings ?? []), ...g.flatMap((a) => a.bindings)]
      return budget
        .run(label, [] as Array<{ c: string; id: string }>, () =>
          budget.query<{ c: string; id: string }>(sql, bindings, { priority })
        )
        .catch(() => {
          planCacheOf().value = null // stale plan — rebuild next request
          return [] as Array<{ c: string; id: string }>
        })
    })
  )
  return results.flat()
}

interface SearchCtx {
  user: User
  budget: SearchBudget
  labelsOnly: boolean
  allowed: Map<string, string[] | null>
  labelOf: LabelOf
  /** Per collection, the caller's read gate as SQL (null = nothing narrows them). */
  access: Map<string, AccessClause | null>
}

/** Text pass: the union of contains-LIKEs (the original omnisearch), as Found hits. */
async function searchUnion(
  ctx: SearchCtx,
  candidates: PlanEntry[],
  q: string,
  phrases: string[],
  perCollection: number
): Promise<Found[]> {
  const colsOf = (p: PlanEntry) => searchColumns(p, ctx.labelsOnly, ctx.allowed.get(p.collection))
  const plan = candidates.filter((p) => p.textSearchable && colsOf(p).length > 0)
  if (plan.length === 0) return []

  // Search synonyms (#1581): the phrase as typed plus its synonym forms. With
  // none (the usual case) the statement is exactly as before; with some, the
  // forms are bound ONCE in a CTE every union member reads, so the parameter
  // count does not multiply by columns × collections.
  const likes = phrases.map((p) => `%${escapeLike(p)}%`)
  // Full-text (search item 24, services/search-fts.ts): where a DBA built a
  // full-text index, its text columns answer through CONTAINS instead of a
  // contains-LIKE scan. Plain searches only (synonym forms keep the LIKE CTE);
  // business-id columns stay on LIKE (CONTAINS matches word starts, not
  // substrings). No index anywhere = exactly the old statement.
  const fts = new Map<string, { cols: string[]; cond: { sql: string; bindings: string[] } }>()
  if (likes.length === 1) {
    await Promise.all(
      plan.map(async (p) => {
        const text = colsOf(p).filter((c) => !p.idColumns.includes(c) && !isIdColumn(c))
        const cols = text.length ? await ftsColumns(p.collection, text).catch(() => []) : []
        const cond = cols.length ? ftsCondition(cols, q) : null
        if (cond) fts.set(p.collection, { cols, cond })
      })
    )
  }
  const prefix =
    likes.length > 1
      ? {
          sql: `WITH nvr_syn(p) AS (${likes.map(() => 'SELECT CAST(? AS nvarchar(410))').join(' UNION ALL ')}) `,
          bindings: likes
        }
      : null
  const arms = plan.map((p) => {
    const ft = fts.get(p.collection)
    return {
      collection: p.collection,
      rows: p.rows,
      ...textArm(
        p,
        colsOf(p),
        q,
        likes,
        ft ?? null,
        perCollection,
        undefined,
        ctx.access.get(p.collection) ?? null
      )
    }
  })
  // Every big table is its own statement with its own share of the search's time
  // budget (a scan that runs past it is cancelled and answers nothing — the answer
  // says which); the small tables go together in one statement.
  const candidatesRows = await runArms(ctx.budget, arms, prefix)
  const rows = await confirmRows(ctx.user, groupCandidates(candidatesRows, perCollection))

  const planByName = new Map(plan.map((p) => [p.collection, p]))
  const forms = phrases.map((ph) => ph.toLowerCase())
  const out: Found[] = []
  for (const [collection, items] of rows) {
    const p = planByName.get(collection)
    if (!p) continue
    for (const item of items) {
      const hit = toHit(p, item, colsOf(p), forms, ctx.labelOf)
      if (!hit) continue
      // labels=1: what the person sees must hold what they typed (or a synonym
      // of it) — unless it matched a configured label search field, which the
      // hit names (matched_label / matched_value) so the person sees why.
      if (
        ctx.labelsOnly &&
        !forms.some((f) => hit.label.toLowerCase().includes(f)) &&
        !p.labelSearch.includes(hit.matched_field ?? '')
      )
        continue
      out.push(hit)
    }
  }
  return out
}

/** After an exact id hit, how long the other scans may still add to the answer. */
const EXACT_GRACE_MS = 300
/** An exact-id seek runs at least this long from its own start, even past the deadline
 *  (army 7 b16 N1): an index seek that started late is never cut by the budget. */
const EXACT_FLOOR_MS = 800

interface ExactSpec {
  collection: string
  cols: string[]
  nums: string[]
  kinds?: Record<string, TextKind>
  /** true: every column leads an index (the arm is a seek); false: a scan. */
  indexed?: boolean
  /** The caller's read gate, judged before the TOP (army 11 Q2-3). */
  access?: AccessClause | null
  /** Rows kept (default EXACT_SEEK_TOP). A grouped collection (one invoice = many
   *  line rows, several invoices may share a number) keeps EXACT_GROUP_TOP, newest
   *  first, so every invoice carrying the number is offered (army 11 a3 G). */
  top?: number
}

/** Rows the exact-id pass keeps per collection (and per column when confirming). */
const EXACT_SEEK_TOP = 2
/** Rows the exact-id pass keeps for a `search_group_by` collection (rows are lines). */
export const EXACT_GROUP_TOP = 60

/**
 * Exact-id pass (item 1): an id-ish query equal to a business-id column of a
 * collection (string `*_id` / `*_number`, numeric `*_number` for digits), or —
 * scoped — the record's own `id`. Readable columns only; every candidate is
 * re-read as the caller and must still show that exact value. Each value is bound
 * in its column's own type (a varchar column compared with an nvarchar value is
 * converted row by row and its index never sought). Exported for tests.
 */
export function exactStatement(
  batch: ExactSpec[],
  q: string,
  mssql = onMssql()
): { sql: string; bindings: unknown[] } | null {
  const parts: string[] = []
  const bindings: unknown[] = []
  const digits = /^\d{1,15}$/.test(q)
  for (const b of batch) {
    const nums = digits ? b.nums : []
    const preds = b.cols.map((c) =>
      typedEquals(`[${c}]`, q, b.kinds?.[c] ?? 'other', { indexed: b.indexed !== false, mssql })
    )
    if (preds.length + nums.length === 0) continue
    const any = [...preds.map((p) => p.sql), ...nums.map((c) => `[${c}] = ?`)].join(' OR ')
    const gate = andAccess(b.access)
    const where = gate.sql ? `(${any})${gate.sql}` : any
    const top = Math.max(1, Math.min(500, Math.floor(b.top ?? EXACT_SEEK_TOP)))
    // More than the default: newest first (an arbitrary TOP of a number shared by
    // several invoices showed the 2025 one and hid the held 2026 one).
    const order = top > EXACT_SEEK_TOP ? ' ORDER BY id DESC' : ''
    parts.push(
      `SELECT * FROM (SELECT TOP ${top} '${b.collection}' AS c, CAST(id AS nvarchar(64)) AS id FROM [${b.collection}] WHERE ${where}${order}) AS [x_${b.collection}]`
    )
    bindings.push(
      ...preds.flatMap((p) => p.bindings),
      ...nums.map(() => Number(q)),
      ...gate.bindings
    )
  }
  return parts.length ? { sql: parts.join(' UNION ALL '), bindings } : null
}

/** A prefix seek runs only for a query at least this long (a 2-letter start would
 *  name five arbitrary rows of a big table). */
const PREFIX_MIN_LEN = 4
/** Rows one prefix seek brings back per column. */
const PREFIX_PER_COLUMN = 5

/**
 * Prefix seeks on the big (seek-only) tables: `[col] LIKE 'q%'` on a column an index
 * leads is a range seek, so an invoice number's start ("INV-PPC-0003") finds its rows
 * without scanning 2.7M of them. One TOP-N subquery per column (OR across two indexes
 * would scan); the value is escaped and bound in the column's own string type (an
 * nvarchar pattern against a varchar column converts every row and never seeks).
 * Exported for tests.
 */
export function prefixStatement(
  batch: Array<{
    collection: string
    cols: string[]
    kinds?: Record<string, TextKind>
    access?: AccessClause | null
  }>,
  q: string,
  mssql = onMssql()
): { sql: string; bindings: unknown[] } | null {
  if (q.length < PREFIX_MIN_LEN) return null
  const pattern = `${escapeLike(q)}%`
  const parts: string[] = []
  const bindings: unknown[] = []
  for (const b of batch) {
    if (!IDENT_RE.test(b.collection)) continue
    for (const c of b.cols) {
      if (!IDENT_RE.test(c)) continue
      const ansi = mssql && b.kinds?.[c] === 'ansi'
      const bound = ansi ? 'CAST(? AS varchar(4000))' : '?'
      const gate = andAccess(b.access)
      parts.push(
        `SELECT * FROM (SELECT TOP ${PREFIX_PER_COLUMN} '${b.collection}' AS c, CAST(id AS nvarchar(64)) AS id FROM [${b.collection}] WHERE [${c}] LIKE ${bound} ESCAPE '\\'${gate.sql}) AS [p_${b.collection}_${c}]`
      )
      bindings.push(pattern, ...gate.bindings)
    }
  }
  return parts.length ? { sql: parts.join(' UNION ALL '), bindings } : null
}

/** Rows one tab seek (counts / records tabs) brings back per column of a big table —
 *  the tab answers from these candidates, so a count past it reads "at least". */
export const TAB_SEEK_PER_COLUMN = 100

/**
 * A big (seek-only) table's candidates for the /counts and /records tabs (army 8
 * review M3): one TOP-N subquery per index-led id column, UNION ALL'd — never an OR
 * across columns (two indexes under one OR scan the 2.7M rows). From PREFIX_MIN_LEN
 * characters it is a prefix seek (`LIKE 'q%'`, the same rule as prefixStatement);
 * a shorter id is an exact seek on each column. Every value is bound in the column's
 * own string type (an nvarchar value against a varchar column never seeks). The ids
 * found are then read AS THE CALLER (`id _in`), so access is judged as usual.
 * Exported for tests.
 */
export function tabSeekStatement(
  p: { collection: string; kinds?: Record<string, TextKind> },
  cols: string[],
  q: string,
  perColumn = TAB_SEEK_PER_COLUMN,
  mssql = onMssql(),
  /** The caller's read gate, judged before each TOP (army 11 Q2-3). */
  access: AccessClause | null = null,
  /** Columns matched only when equal (search_internal_fields): never by their start. */
  equalOnly: string[] = []
): { sql: string; bindings: unknown[] } | null {
  if (!IDENT_RE.test(p.collection) || q.length < 2) return null
  const gate = andAccess(access)
  const longEnough = q.length >= PREFIX_MIN_LEN
  const n = Math.max(1, Math.min(1000, Math.floor(perColumn)))
  const parts: string[] = []
  const bindings: unknown[] = []
  for (const c of cols) {
    if (!IDENT_RE.test(c)) continue
    const kind = p.kinds?.[c] ?? 'other'
    const prefix = longEnough && !equalOnly.includes(c)
    let where: string
    if (prefix) {
      const bound = mssql && kind === 'ansi' ? 'CAST(? AS varchar(4000))' : '?'
      where = `[${c}] LIKE ${bound} ESCAPE '\\'`
      bindings.push(`${escapeLike(q)}%`)
    } else {
      const eq = typedEquals(`[${c}]`, q, kind, { indexed: true, mssql })
      where = eq.sql
      bindings.push(...eq.bindings)
    }
    parts.push(
      `SELECT * FROM (SELECT TOP ${n} CAST(id AS nvarchar(64)) AS id, '${c}' AS k FROM [${p.collection}] WHERE ${where}${gate.sql}) AS [t_${c}]`
    )
    bindings.push(...gate.bindings)
  }
  return parts.length ? { sql: parts.join(' UNION ALL '), bindings } : null
}

/** Split each collection's exact columns into the ones an index leads (one seek
 *  statement for the whole search) and the rest (scans, budgeted per table).
 *  Exported for tests. */
export function splitExactSpecs(
  specs: Array<ExactSpec & { rows: number; indexedCols: string[] }>,
  q: string
): { seek: ExactSpec[]; scan: Array<ExactSpec & { rows: number }> } {
  const digits = /^\d{1,15}$/.test(q)
  const seek: ExactSpec[] = []
  const scan: Array<ExactSpec & { rows: number }> = []
  for (const s of specs) {
    const idx = new Set(s.indexedCols)
    const pick = (list: string[], indexed: boolean) => list.filter((c) => idx.has(c) === indexed)
    const base = {
      collection: s.collection,
      kinds: s.kinds,
      ...(s.access ? { access: s.access } : {}),
      ...(s.top ? { top: s.top } : {})
    }
    const seekCols = pick(s.cols, true)
    const seekNums = digits ? pick(s.nums, true) : []
    if (seekCols.length + seekNums.length > 0)
      seek.push({ ...base, cols: seekCols, nums: seekNums, indexed: true })
    const scanCols = pick(s.cols, false)
    const scanNums = digits ? pick(s.nums, false) : []
    if (scanCols.length + scanNums.length > 0)
      scan.push({ ...base, cols: scanCols, nums: scanNums, indexed: false, rows: s.rows })
  }
  return { seek, scan }
}

async function searchExact(
  ctx: SearchCtx,
  candidates: PlanEntry[],
  q: string,
  scope: string | null
): Promise<Found[]> {
  const specs = candidates
    .map((p) => {
      const allowed = ctx.allowed.get(p.collection)
      return {
        p,
        collection: p.collection,
        rows: p.rows,
        cols: readableOnly(p.idColumns, allowed),
        nums: readableOnly(p.numIdColumns, allowed),
        kinds: p.kinds,
        indexedCols: p.indexed ?? [],
        access: ctx.access.get(p.collection) ?? null,
        ...(p.groupBy ? { top: EXACT_GROUP_TOP } : {})
      }
    })
    .filter((s) => s.cols.length + s.nums.length > 0)
  const { seek, scan } = splitExactSpecs(specs, q)
  const budget = ctx.budget

  // 1. The index-backed path: every seekable id column of every collection plus —
  //    scoped — the record's own id, in one round trip. An exact hit found here
  //    brings the whole search's deadline in: the answer is known.
  const seekPass = (async () => {
    const stmt = exactStatement(seek, q)
    // Seeks: first in the queue, the reserved slot, and a floor past the deadline —
    // an exact record match is never what the budget cuts.
    const seekOpts = { priority: EXACT_PRIORITY, reserved: true, floorMs: EXACT_FLOOR_MS }
    const [byCol, byId] = await Promise.all([
      stmt
        ? budget
            .runQuery<{ c: string; id: string }>('exact', stmt.sql, stmt.bindings, seekOpts)
            .catch(() => [] as Array<{ c: string; id: string }>)
        : [],
      // A primary-key seek, so any table size; its own statement — an id type
      // clash (uuid vs digits) fails only this one.
      scope && candidates.some((p) => p.collection === scope)
        ? budget
            .runQuery<{ c: string; id: string }>(
              'exact:id',
              `SELECT TOP 1 '${scope}' AS c, CAST(id AS nvarchar(64)) AS id FROM [${scope}] WHERE [id] = ?`,
              [/^\d{1,15}$/.test(q) ? Number(q) : q],
              seekOpts
            )
            .catch(() => [] as Array<{ c: string; id: string }>)
        : []
    ])
    const hits = await exactHits(ctx, specs, candidates, [...byId, ...byCol], q, scope)
    if (hits.length > 0) budget.shorten(EXACT_GRACE_MS)
    return hits
  })()
  // 1b. Big (seek-only) tables: the start of an id, as a range seek per column. Never
  //     an exact hit — a prefix row ranks as a prefix match under any exact one.
  const prefixPass = (async () => {
    // Another system's ids (search_internal_fields) are matched whole only: a Fusion
    // invoice id that merely STARTS with the typed number is noise (army 11 a3 G).
    const big = specs
      .filter((s) => s.p.seekOnly)
      .map((s) => ({ ...s, cols: s.cols.filter((c) => !(s.p.internal ?? []).includes(c)) }))
      .filter((s) => s.cols.length > 0)
    if (big.length === 0) return [] as Found[]
    const results = await Promise.all(
      big.map((s) => {
        const stmt = prefixStatement([s], q)
        if (!stmt) return [] as Array<{ c: string; id: string }>
        return budget
          .runQuery<{ c: string; id: string }>(s.collection, stmt.sql, stmt.bindings, {
            priority: EXACT_PRIORITY
          })
          .catch(() => [] as Array<{ c: string; id: string }>)
      })
    )
    const lower = q.toLowerCase()
    return exactHits(ctx, big, candidates, results.flat(), q, null, {
      tier: 'prefix',
      cap: PREFIX_PER_COLUMN,
      test: (v) => {
        const t = v.toLowerCase()
        return t.startsWith(lower) && t !== lower
      }
    })
  })()
  // 1c. The number part of an id (army 11 a4): approvers say "81137" for HQ26-81137.
  //     A digits-only query equal to everything after the last dash of a record's OWN
  //     id (the column its label shows) is an exact match for it.
  const numberPartPass = (async () => {
    const arms = numberPartArms(ctx, candidates, q)
    if (arms.length === 0) return [] as Found[]
    const rows = await runArms(budget, arms, null, EXACT_PRIORITY)
    const tail = `-${q.toLowerCase()}`
    const hits = await exactHits(
      ctx,
      numberPartSpecs(ctx, candidates, q),
      candidates,
      rows,
      q,
      null,
      {
        tier: 'exact',
        cap: EXACT_SEEK_TOP,
        test: (v) => v.toLowerCase().endsWith(tail)
      }
    )
    if (hits.length > 0) budget.shorten(EXACT_GRACE_MS)
    return hits
  })()
  // 2. Id columns no index leads: scans, each big table on its own budget.
  const scanPass = (async () => {
    if (scan.length === 0) return [] as Found[]
    const arms = scan
      .map((s) => ({ collection: s.collection, rows: s.rows, stmt: exactStatement([s], q) }))
      .filter(
        (
          a
        ): a is { collection: string; rows: number; stmt: { sql: string; bindings: unknown[] } } =>
          a.stmt != null
      )
      .map((a) => ({ collection: a.collection, rows: a.rows, ...a.stmt }))
    // Scans (no index leads the column): ahead of the text scans, without a floor.
    const rows = await runArms(budget, arms, null, EXACT_PRIORITY)
    return exactHits(ctx, specs, candidates, rows, q, scope)
  })()
  const [a, b, c, d] = await Promise.all([seekPass, scanPass, prefixPass, numberPartPass])
  const templates = new Map(candidates.map((p) => [p.collection, p.template]))
  return demoteForeignExact([...a, ...b, ...d, ...c], (col) => templates.get(col) ?? null)
}

/** The shortest number part searched as an id ("812" is someone's number; "12" is noise). */
const NUMBER_PART_MIN = 3

/** The collections and own-id columns the number-part pass reads: a table the text pass
 *  may scan (≤ ROW_BUDGET rows), string business-id columns its label template shows,
 *  readable by the caller, never another system's ids. Exported for tests. */
export function numberPartSpecs(
  ctx: Pick<SearchCtx, 'allowed'>,
  candidates: PlanEntry[],
  q: string
): Array<{ p: PlanEntry; collection: string; cols: string[]; nums: string[] }> {
  if (!new RegExp(`^\\d{${NUMBER_PART_MIN},15}$`).test(q)) return []
  return candidates
    .filter((p) => !p.seekOnly && p.textSearchable)
    .map((p) => {
      const own = templateFields(p.template)
      const cols = readableOnly(
        p.idColumns.filter((c) => own.includes(c) && !(p.internal ?? []).includes(c)),
        ctx.allowed.get(p.collection)
      )
      return { p, collection: p.collection, cols, nums: [] as string[] }
    })
    .filter((s) => s.cols.length > 0)
}

/** One budgeted arm per collection: `[col] LIKE '%-81137'` on its own id columns,
 *  behind the caller's read gate. Exported for tests. */
export function numberPartArms(
  ctx: Pick<SearchCtx, 'allowed' | 'access'>,
  candidates: PlanEntry[],
  q: string,
  mssql = onMssql()
): Arm[] {
  return numberPartSpecs(ctx, candidates, q).map((s) => {
    const preds = s.cols.map((c) =>
      fastLike(`[${c}]`, `%-${q}`, kindOfCol(s.p, c), { escape: '\\', mssql })
    )
    const gate = andAccess(ctx.access.get(s.collection))
    return {
      collection: s.collection,
      rows: s.p.rows,
      sql: `SELECT * FROM (SELECT TOP ${EXACT_SEEK_TOP} '${s.collection}' AS c, CAST(id AS nvarchar(64)) AS id FROM [${s.collection}] WHERE (${preds.map((x) => x.sql).join(' OR ')})${gate.sql} ORDER BY id DESC) AS [n_${s.collection}]`,
      bindings: [...preds.flatMap((x) => x.bindings), ...gate.bindings]
    }
  })
}

/** The fields a display template shows (`{{project_id}} - {{name}}` → project_id, name). */
function templateFields(template: string | null): string[] {
  return [...(template ?? '').matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1])
}

/**
 * A record is the exact match for an id when the id is ITS OWN — the column its label
 * shows (projects `{{project_id}} - {{name}}`) or its primary key. A record that only
 * carries that id as a reference (a workflow's `project_id`) is an equal match, ranked
 * under it — but only when some record owns the id: with no owner in the answer the
 * reference match stays exact (army 8 b14: "201953" marked one arbitrary workflow of
 * the project EXACT, above the project itself). Exported for tests.
 */
export function demoteForeignExact<
  H extends { collection: string; matched_field?: string; exact?: boolean; tier: MatchTier }
>(hits: H[], templateOf: (collection: string) => string | null): H[] {
  const own = (h: H) =>
    h.matched_field === 'id' ||
    templateFields(templateOf(h.collection)).includes(h.matched_field ?? '')
  if (!hits.some((h) => h.exact && own(h))) return hits
  return hits.map((h) => (h.exact && !own(h) ? { ...h, exact: false, tier: 'equal' as const } : h))
}

/** Exact candidates → hits the caller may read that still show the exact value.
 *  With `prefix` (the big-table prefix seeks): hits whose value STARTS with the
 *  query, as prefix-tier matches, never exact. */
async function exactHits(
  ctx: SearchCtx,
  specs: Array<{
    p: PlanEntry
    collection: string
    cols: string[]
    nums: string[]
    top?: number
  }>,
  candidates: PlanEntry[],
  found: Array<{ c: string; id: string }>,
  q: string,
  scope: string | null,
  /** A looser match than equality: the big-table prefix seeks (tier prefix) and the
   *  number part of an id (tier exact). */
  mode?: { tier: 'prefix' | 'exact'; cap: number; test: (value: string) => boolean }
): Promise<Found[]> {
  if (found.length === 0) return []
  const prefix = mode?.tier === 'prefix'
  const capOf = (c: string) =>
    mode?.cap ?? specs.find((s) => s.collection === c)?.top ?? EXACT_SEEK_TOP
  const rows = await confirmRows(ctx.user, groupCandidates(found, capOf))
  const lower = q.toLowerCase()
  const matches = mode?.test ?? ((v: string) => v.toLowerCase() === lower)
  const out: Found[] = []
  for (const [collection, items] of rows) {
    const spec = specs.find((s) => s.collection === collection)
    const p = spec?.p ?? candidates.find((c) => c.collection === collection)
    if (!p) continue
    const idReadable = readableOnly(['id'], ctx.allowed.get(collection)).length > 0
    // Several records share the value (four vendors' invoices numbered 10020): the
    // newest first, so ties under one score read newest-first (army 11 a3 G).
    for (const item of [...items].sort(newestFirst)) {
      let col = [...(spec?.cols ?? []), ...(spec?.nums ?? [])].find(
        (c) => item[c] != null && matches(String(item[c]))
      )
      if (
        !col &&
        !prefix &&
        scope === collection &&
        idReadable &&
        String(item.id).toLowerCase() === lower
      )
        col = 'id'
      if (!col) continue
      const value = String(item[col])
      // A pk match shows no pk: the label falls back and no "ID: 123" chip rides along.
      // Nor does another system's id (search_internal_fields, army 11 a3 G).
      const byPk = col === 'id' || (p.internal ?? []).includes(col)
      const label = hitLabel(p, item, byPk ? '' : value)
      out.push(
        withRowFacts(
          {
            collection,
            display_name: p.display_name,
            id: item.id,
            label,
            snippet: (byPk ? label : value).slice(0, 120),
            matched_field: col,
            ...(byPk
              ? {}
              : { matched_label: ctx.labelOf(collection, col), matched_value: value.slice(0, 80) }),
            ...(prefix ? { tier: 'prefix' as const } : { exact: true, tier: 'exact' as const })
          },
          item
        )
      )
    }
  }
  return out
}

/** The typo pass statement (item 4): rows where enough 3-letter chunks of the
 *  query appear in a name column, best first. Exported for tests. */
export function fuzzyStatement(
  batch: Array<{
    collection: string
    cols: string[]
    kinds?: Record<string, TextKind>
    access?: AccessClause | null
  }>,
  q: string,
  mssql = onMssql(),
  /** Rows kept per collection (a record picker's typo pass keeps more). */
  top = FUZZY_PER_COLLECTION
): { sql: string; bindings: unknown[] } | null {
  const { chunks, need } = fuzzyChunks(q)
  const n = Math.max(1, Math.min(50, Math.floor(top)))
  if (chunks.length < 2) return null
  const parts: string[] = []
  const bindings: unknown[] = []
  for (const b of batch) {
    if (b.cols.length === 0) continue
    const likes = b.cols.map((c) =>
      chunks.map((ch) =>
        fastLike(`t.[${c}]`, `%${escapeLike(ch)}%`, b.kinds?.[c] ?? 'other', {
          escape: '\\',
          mssql
        })
      )
    )
    const sums = likes.map(
      (ls, i) => `(${ls.map((l) => `CASE WHEN ${l.sql} THEN 1 ELSE 0 END`).join(' + ')}) AS s${i}`
    )
    const any = b.cols.map((_, i) => `x.s${i} >= ${need}`).join(' OR ')
    const gate = andAccess(onIdExpr(b.access, 't.[id]'))
    const where = gate.sql ? `(${any})${gate.sql}` : any
    const best = b.cols.length > 1 ? `CASE WHEN x.s0 >= x.s1 THEN x.s0 ELSE x.s1 END` : 'x.s0'
    parts.push(
      `SELECT * FROM (SELECT TOP ${n} '${b.collection}' AS c, CAST(t.id AS nvarchar(64)) AS id FROM [${b.collection}] AS t CROSS APPLY (SELECT ${sums.join(', ')}) AS x WHERE ${where} ORDER BY ${best} DESC, t.id DESC) AS [f_${b.collection}]`
    )
    for (const ls of likes) for (const l of ls) bindings.push(...l.bindings)
    bindings.push(...gate.bindings)
  }
  return parts.length ? { sql: parts.join(' UNION ALL '), bindings } : null
}

async function searchFuzzy(ctx: SearchCtx, candidates: PlanEntry[], q: string): Promise<Found[]> {
  const specs = candidates
    .filter((p) => p.textSearchable && p.rows <= FUZZY_ROW_BUDGET)
    .map((p) => {
      const cols = searchColumns(p, ctx.labelsOnly, ctx.allowed.get(p.collection))
      // Name-like columns only: the label's, else the first search column.
      const named = cols.filter((c) => p.labelColumns.includes(c) || NAMEISH.includes(c))
      return {
        p,
        collection: p.collection,
        rows: p.rows,
        kinds: p.kinds,
        cols: (named.length ? named : cols).slice(0, 2),
        access: ctx.access.get(p.collection) ?? null
      }
    })
    .filter((s) => s.cols.length > 0)
  const arms = specs
    .map((s) => ({ collection: s.collection, rows: s.rows, stmt: fuzzyStatement([s], q) }))
    .filter(
      (a): a is { collection: string; rows: number; stmt: { sql: string; bindings: unknown[] } } =>
        a.stmt != null
    )
    .map((a) => ({ collection: a.collection, rows: a.rows, ...a.stmt }))
  if (arms.length === 0) return []
  const rows = await confirmRows(
    ctx.user,
    groupCandidates(await runArms(ctx.budget, arms), FUZZY_PER_COLLECTION)
  )
  const out: Found[] = []
  for (const [collection, items] of rows) {
    const spec = specs.find((s) => s.collection === collection)
    if (!spec) continue
    for (const item of items) {
      let best: { col: string; value: string; sim: number } | null = null
      for (const c of spec.cols) {
        const v = item[c]
        if (v == null || typeof v === 'object') continue
        const sim = similarity(q, String(v))
        if (!best || sim > best.sim) best = { col: c, value: String(v), sim }
      }
      if (!best || best.sim < FUZZY_MIN_SIMILARITY) continue
      out.push(
        withRowFacts(
          {
            collection,
            display_name: spec.p.display_name,
            id: item.id,
            label: hitLabel(spec.p, item, best.value),
            snippet: best.value.slice(0, 120),
            matched_field: best.col,
            matched_label: ctx.labelOf(collection, best.col),
            matched_value: best.value.slice(0, 80),
            tier: 'fuzzy',
            similarity: best.sim
          },
          item
        )
      )
    }
  }
  return out
}

/** The items-service filter for "any search column contains the phrase (or a synonym)". */
async function matchFilter(cols: string[], q: string): Promise<Record<string, unknown>> {
  const phrases = await searchPhrases(q).catch(() => [q])
  return phraseFilter(cols, phrases)
}

const phraseFilter = (cols: string[], phrases: string[]) => ({
  _or: phrases.flatMap((ph) => cols.map((c) => ({ [c]: { _contains: ph } })))
})

/** The text filter AND the field filters, for the items service. Exported for tests. */
export function combinedFilter(
  textFilter: Record<string, unknown> | null,
  clauses: Array<Record<string, unknown>>
): Record<string, unknown> {
  const all = [...(textFilter ? [textFilter] : []), ...clauses]
  return all.length === 1 ? all[0] : { _and: all }
}

const FILTER_CONCURRENCY = 4

/**
 * Filtered pass (items 2/3/16): each target collection read through the items
 * service as the caller with the text filter AND the field filters — RBAC, row
 * filters, User Scopes and field permissions all apply; the clauses only name
 * fields the caller may read (planFilters got readable fields only).
 */
async function searchFiltered(
  ctx: SearchCtx,
  plan: PlanEntry[],
  targets: Map<string, Array<Record<string, unknown>>>,
  text: string,
  phrases: string[],
  chips: FilterChip[],
  perCollection: number
): Promise<Found[]> {
  const byName = new Map(plan.map((p) => [p.collection, p]))
  const list = [...targets.entries()]
    .map(([c, clauses]) => ({ p: byName.get(c), clauses }))
    .filter((t): t is { p: PlanEntry; clauses: Array<Record<string, unknown>> } => !!t.p)
    .sort((a, b) => a.p.rows - b.p.rows)
    .slice(0, FILTER_COLLECTIONS)
  const forms = phrases.map((f) => f.toLowerCase())
  const out: Found[] = []
  for (let i = 0; i < list.length; i += FILTER_CONCURRENCY) {
    await Promise.all(
      list.slice(i, i + FILTER_CONCURRENCY).map(async ({ p, clauses }) => {
        const cols = searchColumns(p, ctx.labelsOnly, ctx.allowed.get(p.collection))
        // Text with no column to match it on cannot match: the collection sits out.
        if (text && cols.length === 0) return
        try {
          const r = await ctx.budget.run<{ data: unknown[] }>(p.collection, { data: [] }, () =>
            readItems(ctx.user, p.collection, {
              filter: combinedFilter(text ? phraseFilter(cols, phrases) : null, clauses),
              sort: ['-id'],
              limit: perCollection,
              count: false
            })
          )
          for (const item of r.data as Array<Record<string, unknown>>) {
            if (text) {
              const hit = toHit(p, item, cols, forms, ctx.labelOf)
              if (hit) out.push(hit)
              continue
            }
            // Filters only: the hit is "matched" by its first filter field.
            const f = chips.find((c) => c.field in item)?.field
            const value = f != null && item[f] != null ? String(item[f]) : ''
            const label = hitLabel(p, item, matchedText(p, item))
            out.push(
              withRowFacts(
                {
                  collection: p.collection,
                  display_name: p.display_name,
                  id: item.id,
                  label,
                  snippet: (value || label).slice(0, 120),
                  ...(f ? { matched_field: f, matched_label: ctx.labelOf(p.collection, f) } : {}),
                  ...(value ? { matched_value: value.slice(0, 80) } : {}),
                  tier: 'contains'
                },
                item
              )
            )
          }
        } catch {
          /* unreadable, or the filter was refused — no hits from it */
        }
      })
    )
  }
  return out
}

/** Merge passes: one hit per record, the best tier wins (exact first). Exported for tests. */
export function mergeFound(...lists: Found[][]): Found[] {
  const order: MatchTier[] = ['exact', 'equal', 'prefix', 'word', 'contains', 'fuzzy']
  const by = new Map<string, Found>()
  for (const list of lists) {
    for (const h of list) {
      const k = hitKey(h.collection, h.id)
      const prev = by.get(k)
      if (!prev || order.indexOf(h.tier) < order.indexOf(prev.tier)) by.set(k, h)
    }
  }
  return [...by.values()]
}

/** Score every hit with the caller's signals and drop the internals. Exported for tests. */
export function finishHits(
  found: Found[],
  signals: {
    userId: string
    learned: Map<string, number>
    recent: Set<string>
    owned: Set<string>
  },
  cap = RECORD_CAP
): RecordHit[] {
  const me = signals.userId.toLowerCase()
  const scored = found.map((h) => {
    const k = hitKey(h.collection, h.id)
    const mine =
      (h.createdBy != null && h.createdBy.toLowerCase() === me) ||
      signals.recent.has(k) ||
      signals.owned.has(k)
    const { tier, similarity: sim, createdBy: _c, ...hit } = h
    return {
      ...hit,
      ...(mine ? { mine: true } : {}),
      score: scoreHit({ tier, similarity: sim, mine, learned: signals.learned.get(k) ?? 0 })
    } as RecordHit
  })
  return rankHits(scored).slice(0, cap)
}

function searchGroupPlan(browserConfig: unknown): { groupBy?: string; detail?: string[] } {
  const g = searchGroupOf(browserConfig)
  const groupDetail = g.by ? searchGroupDetailOf(browserConfig) : []
  return {
    ...(g.by ? { groupBy: g.by } : {}),
    ...(g.detail.length ? { detail: g.detail } : {}),
    ...(groupDetail.length ? { groupDetail } : {})
  }
}

/**
 * One palette row per shared value of a collection's `search_group_by` field (pure;
 * exported for tests) — an invoice's 25 lines all carry its number (army 9 b07/b16).
 * `groupOf` is the field's value per `collection:id`, read AS THE CALLER; a hit with no
 * known value (no grouping configured, field not readable) is never merged, so two
 * different records that only LOOK alike stay two rows (Fable H2). The kept row is the
 * best-ranked one, exact when any member was, with `group_size` = members seen and
 * `group_more` when that collection's hits were capped (there may be more).
 */
export function groupHits<T extends RecordHit>(
  hits: T[],
  groupOf: Map<string, string>,
  cappedCollections: ReadonlySet<string> = new Set()
): T[] {
  const first = new Map<string, number>()
  const out: T[] = []
  for (const h of hits) {
    const v = groupOf.get(hitKey(h.collection, h.id))
    const k = v == null || v === '' ? null : `${h.collection}\u0000${v}`
    const at = k ? first.get(k) : undefined
    if (k == null || at === undefined) {
      if (k) first.set(k, out.length)
      out.push(h)
      continue
    }
    const kept = out[at]
    out[at] = {
      ...kept,
      group_size: (kept.group_size ?? 1) + 1,
      ...(cappedCollections.has(h.collection) ? { group_more: true } : {}),
      ...(h.exact && !kept.exact ? { exact: true } : {}),
      ...(h.mine && !kept.mine ? { mine: true } : {})
    }
  }
  return out
}

/** The `search_group_by` value of each hit in a grouped collection, read as the caller
 *  by primary key (one read per grouped collection, ≤ RECORD_CAP ids — no count, no
 *  scan; Fable M4 dropped the per-group COUNT). */
async function groupValues(
  user: User,
  plan: PlanEntry[],
  hits: RecordHit[],
  /** Filled with each hit's value as stored (the returned map is lower-cased). */
  raw: Map<string, unknown> = new Map()
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const by = new Map(plan.filter((p) => p.groupBy).map((p) => [p.collection, p.groupBy as string]))
  const ids = new Map<string, string[]>()
  for (const h of hits) {
    if (!by.has(h.collection)) continue
    const list = ids.get(h.collection) ?? []
    list.push(String(h.id))
    ids.set(h.collection, list)
  }
  await Promise.all(
    [...ids].map(async ([collection, list]) => {
      if (list.length < 2) return
      const field = by.get(collection) as string
      try {
        const r = await readItems(user, collection, {
          filter: { id: { _in: list } },
          fields: ['id', field],
          limit: list.length
        })
        for (const row of r.data as Array<Record<string, unknown>>) {
          const v = row[field]
          if (v != null && typeof v !== 'object' && String(v).trim()) {
            out.set(hitKey(collection, row.id), String(v).trim().toLowerCase())
            raw.set(hitKey(collection, row.id), v)
          }
        }
      } catch {
        /* unreadable: no grouping */
      }
    })
  )
  return out
}

/**
 * The collections whose grouped rows may hold more members than the search saw (army 10:
 * "INV-PPC-000378 · 2 lines" for an invoice with 25). The exact-id pass keeps the first
 * EXACT_SEEK_TOP rows per collection and an exact hit cuts the scans short, so neither a
 * full per-collection cap nor a full exact pass nor a cut part proves the group complete.
 * Pure; exported for tests.
 */
export function groupsMayHaveMore(args: {
  found: Array<{ collection: string }>
  exact: Array<{ collection: string }>
  per: number
  cut: boolean
  grouped: string[]
  /** Rows the exact pass keeps per collection (grouped collections keep more). */
  exactTop?: (collection: string) => number
}): Set<string> {
  const count = (list: Array<{ collection: string }>) => {
    const by = new Map<string, number>()
    for (const h of list) by.set(h.collection, (by.get(h.collection) ?? 0) + 1)
    return by
  }
  const out = new Set<string>()
  for (const [c, n] of count(args.found)) if (n >= args.per) out.add(c)
  for (const [c, n] of count(args.exact))
    if (n >= (args.exactTop?.(c) ?? EXACT_SEEK_TOP)) out.add(c)
  if (args.cut) for (const c of args.grouped) out.add(c)
  return out
}

/**
 * A grouped row's second line from `search_group_detail` (army 11 a3 G: four vendors'
 * invoices all read "10020"): the vendor and date, read AS THE CALLER, replace a snippet
 * that only repeats the label. A value the caller cannot read is simply missing. Pure
 * apart from `read` (exported for tests; `read` stands in for the items-service read).
 */
export async function withGroupDetail<T extends RecordHit>(
  user: User,
  plan: Array<Pick<PlanEntry, 'collection' | 'groupBy' | 'groupDetail'>>,
  hits: T[],
  read: (
    collection: string,
    ids: string[],
    fields: string[]
  ) => Promise<Array<Record<string, unknown>>> = async (collection, ids, fields) =>
    (
      await readItems(user, collection, {
        filter: { id: { _in: ids } },
        fields: ['id', ...fields],
        limit: ids.length
      })
    ).data as Array<Record<string, unknown>>,
  metaOf: (collection: string) => Promise<Array<Pick<CMSField, 'field' | 'type'>>> = (c) =>
    getFields(c).catch(() => [])
): Promise<T[]> {
  const detailOf = new Map(
    plan
      .filter((p) => p.groupBy && p.groupDetail?.length)
      .map((p) => [p.collection, p.groupDetail ?? []])
  )
  const repeats = (h: T) =>
    (h.snippet ?? '').trim().toLowerCase() === h.label.trim().toLowerCase() || !h.matched_value
  const want = new Map<string, string[]>()
  for (const h of hits) {
    if (!detailOf.has(h.collection) || !repeats(h)) continue
    const list = want.get(h.collection) ?? []
    list.push(String(h.id))
    want.set(h.collection, list)
  }
  if (want.size === 0) return hits
  const lines = new Map<string, string>()
  await Promise.all(
    [...want].map(async ([collection, ids]) => {
      const paths = detailOf.get(collection) ?? []
      try {
        const [rows, metas] = await Promise.all([read(collection, ids, paths), metaOf(collection)])
        const meta = new Map(metas.map((m) => [m.field, m]))
        for (const row of rows) {
          const parts = paths.flatMap((path) => {
            const [head, tail] = path.split('.')
            const raw = row[head]
            const v =
              tail == null
                ? raw
                : raw != null && typeof raw === 'object'
                  ? (raw as Record<string, unknown>)[tail]
                  : null
            const text = previewValue(tail == null ? (meta.get(head) as never) : undefined, v)
            return text ? [text] : []
          })
          if (parts.length) lines.set(hitKey(collection, row.id), parts.join(' · ').slice(0, 120))
        }
      } catch {
        /* unreadable: the row keeps its snippet */
      }
    })
  )
  return hits.map((h) => {
    const line = lines.get(hitKey(h.collection, h.id))
    return line ? { ...h, snippet: line } : h
  })
}

/** Grouped rows counted exactly per search (each one indexed equality count). */
const GROUP_COUNT_MAX = 3
/** How long an exact group count may take before the row keeps its "N+". */
const GROUP_COUNT_MS = 600

/**
 * Replace "N+" with the true member count where it is cheap (army 10): a grouped row
 * flagged group_more whose group_by column leads an index is counted AS THE CALLER — one
 * equality read through the items service, so row filters and User Scopes apply. A count
 * that fails or runs past GROUP_COUNT_MS leaves the honest "N+". Exported for tests
 * (`count` stands in for the items-service read).
 */
export async function countGroupMembers<T extends RecordHit>(
  records: T[],
  plan: Array<Pick<PlanEntry, 'collection' | 'groupBy' | 'indexed'>>,
  raw: Map<string, unknown>,
  count: (collection: string, field: string, value: unknown) => Promise<number | null>,
  ms = GROUP_COUNT_MS
): Promise<T[]> {
  const targets = records
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.group_more === true && (r.group_size ?? 0) >= 2)
    .slice(0, GROUP_COUNT_MAX)
  if (targets.length === 0) return records
  const out = [...records]
  await Promise.all(
    targets.map(async ({ r, i }) => {
      const p = plan.find((x) => x.collection === r.collection)
      const field = p?.groupBy
      if (!field || !(p?.indexed ?? []).includes(field)) return
      const value = raw.get(hitKey(r.collection, r.id))
      if (value == null) return
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms)
      })
      const n = await Promise.race([count(r.collection, field, value).catch(() => null), late])
      if (timer) clearTimeout(timer)
      if (typeof n !== 'number' || !Number.isFinite(n)) return
      const { group_more: _more, ...rest } = r
      out[i] = { ...rest, group_size: Math.max(n, r.group_size ?? 0) } as T
    })
  )
  return out
}

interface RecordSearchResult {
  records: RecordHit[]
  exact: RecordHit | null
  chips: FilterChip[]
  text: string
  suggestions: string[]
}

/** Each candidate collection's readable fields, as the query parser wants them. */
function readableMetas(
  plan: Array<{ collection: string }>,
  fieldRows: FieldRow[],
  allowed: Map<string, string[] | null>
): Map<string, FieldMeta[]> {
  const by = new Map<string, FieldMeta[]>()
  for (const p of plan) by.set(p.collection, [])
  for (const f of fieldRows) {
    const list = by.get(f.collection)
    if (!list) continue
    const a = allowed.get(f.collection)
    if (a != null && !a.includes('*') && !a.includes(f.field)) continue
    list.push({ field: f.field, label: f.label ?? null, type: String(f.type ?? '') })
  }
  return by
}

/**
 * Readable ids (#776) for the hits, read as the caller (recordDisplayRefs);
 * `collection:id` → value, only where one resolved (never the `#id` fallback).
 * Collections with no friendly id field cost nothing.
 */
async function friendlyIdsAmong(
  user: User,
  byCollection: Map<string, string[]>
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  await Promise.all(
    [...byCollection].map(async ([collection, ids]) => {
      const refs = await recordDisplayRefs(collection, ids, { recipient: user })
      for (const [id, ref] of refs) {
        if (ref !== fallbackDisplayRef(id)) out.set(`${collection}:${id}`, ref)
      }
    })
  )
  return out
}

/** Everything the record half of one search does. */
async function searchRecords(
  user: User,
  readable: string[],
  parsed: ParsedQuery,
  labelsOnly: boolean,
  fieldRows: FieldRow[],
  /** The query as typed — what the palette logs, so what learned ranking keys on. */
  raw: string,
  budget: SearchBudget
): Promise<RecordSearchResult> {
  const readableSet = new Set(readable)
  const scope = parsed.scope && parsed.scope !== PEOPLE_SCOPE ? parsed.scope : null
  let plan = (await buildSearchPlan()).filter((p) => readableSet.has(p.collection))
  if (scope) plan = plan.filter((p) => p.collection === scope)
  const empty = { records: [], exact: null, chips: [], text: parsed.text, suggestions: [] }
  if (plan.length === 0) return empty
  // The caller's read gate per collection, as SQL every candidate statement carries
  // (army 11 Q2-3): a scoped person's TOP n are rows they can read.
  const [allowed, access] = await Promise.all([
    allowedByCollection(user, plan),
    searchAccessClauses(
      user,
      plan.map((p) => p.collection)
    ).catch(() => new Map<string, AccessClause | null>())
  ])
  const ctx: SearchCtx = {
    user,
    budget,
    labelsOnly,
    allowed,
    labelOf: fieldLabelMap(fieldRows),
    access
  }

  const filters: FilterPlan = planFilters(parsed, readableMetas(plan, fieldRows, allowed), {
    scope
  })
  const text = filters.text
  const filtering = filters.targets != null
  // Asked to filter by fields no readable collection has: nothing matches.
  if (!filtering && hasFilterTokens(parsed) && filters.chips.length === 0 && text.length < 2)
    return { ...empty, text }
  const phrases = text.length >= 2 ? await searchPhrases(text).catch(() => [text]) : []
  const per = scope ? RECORD_CAP : PER_COLLECTION

  // The exact-id pass goes first: its index seeks take the search's first
  // connection slot, and an exact hit brings the deadline of the scans in.
  const exactP =
    !filtering && looksLikeId(text)
      ? searchExact(ctx, plan, text, scope)
      : Promise.resolve([] as Found[])
  const [main, exact] = await Promise.all([
    filtering
      ? searchFiltered(
          ctx,
          plan,
          filters.targets as Map<string, Array<Record<string, unknown>>>,
          text,
          phrases,
          filters.chips,
          per
        )
      : text.length >= 2
        ? searchUnion(ctx, plan, text, phrases, per)
        : Promise.resolve([] as Found[]),
    exactP
  ])
  // Typo pass only when the exact and contains passes found little.
  const fuzzy =
    !filtering && main.length + exact.length < 3 && wantsFuzzy(text)
      ? await searchFuzzy(ctx, plan, text).catch(() => [] as Found[])
      : []
  const found = mergeFound(exact, main, fuzzy)

  const byCollection = new Map<string, string[]>()
  for (const h of found) {
    const list = byCollection.get(h.collection) ?? []
    list.push(String(h.id))
    byCollection.set(h.collection, list)
  }
  const [learned, recent, owned, friendly] = await Promise.all([
    learnedOpens(raw).catch(() => new Map<string, number>()),
    recentOpens(String(user.id)).catch(() => new Set<string>()),
    ownedAmong(String(user.id), byCollection).catch(() => new Set<string>()),
    friendlyIdsAmong(user, byCollection).catch(() => new Map<string, string>())
  ])
  // Ranked in full, capped after grouping: a grouped collection's exact pass brings an
  // invoice's lines (up to EXACT_GROUP_TOP rows) that collapse into one row per invoice.
  const finished = finishHits(
    found,
    { userId: String(user.id), learned, recent, owned },
    Number.POSITIVE_INFINITY
  ).map((r) => {
    const f = friendly.get(`${r.collection}:${String(r.id)}`)
    return f ? { ...r, friendly_id: f } : r
  })
  // Collections where a group may be larger than the hits seen (a full cap, a full exact
  // pass, a part cut short); the true count replaces "N+" where it is one indexed read.
  const capped = groupsMayHaveMore({
    found,
    exact,
    per,
    cut: budget.timedOut.size + budget.trimmed.size > 0,
    grouped: plan.filter((p) => p.groupBy).map((p) => p.collection),
    exactTop: (c) =>
      plan.find((p) => p.collection === c)?.groupBy ? EXACT_GROUP_TOP : EXACT_SEEK_TOP
  })
  const groupRaw = new Map<string, unknown>()
  const grouped = groupHits(
    finished,
    await groupValues(user, plan, finished, groupRaw),
    capped
  ).slice(0, RECORD_CAP)
  const records = await countGroupMembers(
    await withGroupDetail(user, plan, grouped),
    plan,
    groupRaw,
    async (collection, field, value) => {
      const r = await readItems(user, collection, {
        filter: { [field]: { _eq: value } },
        fields: ['id'],
        limit: 1
      })
      const total = (r as { total?: unknown }).total
      return typeof total === 'number' ? total : null
    }
  )
  const exactHits = records.filter((r) => r.exact)
  // "Did you mean": only when nothing but near spellings came back.
  const suggestions =
    main.length + exact.length === 0 && fuzzy.length > 0
      ? [
          ...new Set(
            [...fuzzy]
              .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
              .map((h) => (h.matched_value ?? '').trim())
              .filter((v) => v && v.toLowerCase() !== text.toLowerCase())
          )
        ].slice(0, 3)
      : []
  return {
    records,
    exact: exactHits.length === 1 ? exactHits[0] : null,
    chips: filters.chips,
    text,
    suggestions
  }
}

// ─── People ───────────────────────────────────────────────────────────────────
//
// One extra TOP-N query over nivaro_users (army 2026-10-25: finding a person
// meant leaving the palette for the Users page). Matches name, email and job
// title, ranked like the record arms: exact, then prefix, then newest. A
// non-admin gets the person directory GET /users gives them — directory
// columns only, no suspended, redacted, placeholder or machine account; an
// admin also finds suspended and machine accounts (where they are managed),
// with their status and kind so the palette can say so.

export const PEOPLE_CAP = 6
const PEOPLE_DIRECTORY_COLS = ['id', 'first_name', 'last_name', 'email', 'title', 'department']
const PEOPLE_ADMIN_COLS = [...PEOPLE_DIRECTORY_COLS, 'status', 'account_kind']
const PEOPLE_MAX_TERMS = 4
const PEOPLE_SEARCH_COLS = ['first_name', 'last_name', 'email', 'title']

export interface PersonHit {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  title: string | null
  department: string | null
  status?: string | null
  account_kind?: string | null
}

/** The people query for one search, as the caller; null = this caller finds
 *  nobody. `readable` is what a non-admin may read of nivaro_users (the
 *  system-collections list; injectable for tests). Exported for tests. */
export function peopleSearchQuery(
  knex: Knex,
  q: string,
  isAdmin: boolean,
  readable: readonly string[] | null = systemReadableColumns('nivaro_users')
): Knex.QueryBuilder | null {
  // Never wider than what a non-admin may read of nivaro_users through /items,
  // and never searched or ranked on a column they cannot read (a match on a
  // withheld column would answer for it). No list, or no id: deny.
  const allowed = new Set(readable ?? [])
  if (!isAdmin && !allowed.has('id')) return null
  const may = (c: string) => isAdmin || allowed.has(c)
  const cols = isAdmin ? PEOPLE_ADMIN_COLS : PEOPLE_DIRECTORY_COLS.filter(may)
  const searchable = PEOPLE_SEARCH_COLS.filter(may)
  const phrase = q.trim()
  if (searchable.length === 0 || !phrase) return null
  const qb = knex('nivaro_users').select(cols).limit(PEOPLE_CAP)
  if (isAdmin) {
    // Anonymised and legacy placeholder rows are noise even for an admin.
    qb.where('is_redacted', false)
      .whereRaw(`email not like 'legacy-%'`)
      .whereRaw(`email not like 'Redacted\\_%' escape '\\'`)
  } else {
    applyDirectoryListingRules(qb)
  }
  // AND across words, OR across columns, so "Jane Doe" and "doe finance" hit.
  for (const term of phrase.split(/\s+/).slice(0, PEOPLE_MAX_TERMS)) {
    const like = `%${escapeLike(term)}%`
    qb.where((inner) => {
      for (const c of searchable) inner.orWhereRaw(`[${c}] LIKE ? ESCAPE '\\'`, [like])
    })
  }
  // Rank exact, then prefix, then newest — on readable columns only.
  const ranked = searchable.map((c) => `[${c}]`)
  if (may('first_name') && may('last_name')) ranked.push(`CONCAT([first_name], ' ', [last_name])`)
  const prefix = `${escapeLike(phrase)}%`
  const exact = ranked.map((e) => `${e} = ?`).join(' OR ')
  const starts = ranked.map((e) => `${e} LIKE ? ESCAPE '\\'`).join(' OR ')
  const newest = may('created_at') ? '[created_at] DESC' : '[last_name], [first_name]'
  qb.orderByRaw(`CASE WHEN ${exact} THEN 0 WHEN ${starts} THEN 1 ELSE 2 END, ${newest}`, [
    ...ranked.map(() => phrase),
    ...ranked.map(() => prefix)
  ])
  return qb
}

async function searchPeople(q: string, isAdmin: boolean): Promise<PersonHit[]> {
  try {
    const qb = peopleSearchQuery(db as unknown as Knex, q, isAdmin)
    return qb ? ((await qb) as PersonHit[]) : []
  } catch {
    return []
  }
}

function matchStatic(
  list: { label: string; path: string; keywords?: string }[],
  forms: string[],
  cap: number
) {
  const lowers = forms.map((f) => f.toLowerCase())
  return list
    .filter((p) =>
      lowers.some(
        (lower) =>
          p.label.toLowerCase().includes(lower) ||
          (p.keywords ?? '').toLowerCase().includes(lower) ||
          p.path.toLowerCase().includes(lower)
      )
    )
    .slice(0, cap)
    .map(({ label, path }) => ({ label, path }))
}

// ─── One collection's matches (the search's collection tabs) ─────────────────

const COUNT_CONCURRENCY = 4
export const PAGE_MAX = 50

/** One collection's readable fields with labels (counts / records tabs). */
async function readableFieldMetas(
  collection: string,
  allowed: string[] | null
): Promise<FieldRow[]> {
  const rows = (await db('nivaro_fields')
    .where({ collection })
    .select('collection', 'field', 'type', 'hidden', 'sort', 'label')
    .catch(() => [])) as FieldRow[]
  return allowed == null || allowed.includes('*')
    ? rows
    : rows.filter((r) => allowed.includes(r.field))
}

/** The filter for one collection's tab: the text (if any) AND the field filters the
 *  query names (null = this collection is out of the search). */
async function tabFilter(
  p: PlanEntry,
  parsed: ParsedQuery,
  labelsOnly: boolean,
  allowed: string[] | null,
  /** The caller, whose read gate the big-table seeks carry (army 11 Q2-3). */
  user?: User
): Promise<{
  filter: Record<string, unknown>
  cols: string[]
  text: string
  /** A big table's candidates hit the per-column cap: the count is "at least". */
  capped?: boolean
} | null> {
  const fields = await readableFieldMetas(p.collection, allowed)
  const metas = new Map([
    [
      p.collection,
      fields.map((f) => ({ field: f.field, label: f.label ?? null, type: String(f.type ?? '') }))
    ]
  ])
  // A tab is one collection: its amounts and dates resolve there, like a scope.
  const plan = planFilters(parsed, metas, { scope: p.collection })
  const clauses = plan.targets?.get(p.collection) ?? []
  const text = plan.text
  // A big (seek-only) table answers an id or its start through its index-led id
  // columns only: one typed TOP-N seek per column (tabSeekStatement), then the ids
  // found read as the caller — never an OR of LIKEs across indexes (a scan of
  // 2.7M rows per 2-character search, army 8 review M3), never a contains scan.
  if (p.seekOnly) {
    const seek = readableOnly(p.idColumns, allowed)
    if (text.length < 2 || !looksLikeId(text) || seek.length === 0) return null
    const access = user ? await searchAccessClause(user, p.collection).catch(() => null) : null
    const stmt = tabSeekStatement(
      p,
      seek,
      text,
      TAB_SEEK_PER_COLUMN,
      undefined,
      access,
      p.internal ?? []
    )
    if (!stmt) return null
    const rows = (await db.raw(stmt.sql, stmt.bindings as Knex.RawBinding[])) as unknown as Array<{
      id: string
      k: string
    }>
    const ids = [...new Set((rows ?? []).map((r) => String(r.id)))]
    if (ids.length === 0) return null
    // A column that filled its TOP-N may hold more: a count from these is a floor.
    const perCol = new Map<string, number>()
    for (const r of rows ?? []) perCol.set(r.k, (perCol.get(r.k) ?? 0) + 1)
    const capped = [...perCol.values()].some((n) => n >= TAB_SEEK_PER_COLUMN)
    return {
      filter: combinedFilter({ id: { _in: ids } }, clauses),
      cols: seek,
      text,
      ...(capped ? { capped: true } : {})
    }
  }
  const cols = searchColumns(p, labelsOnly, allowed)
  if (text.length >= 2 && cols.length === 0) return null
  if (text.length < 2 && clauses.length === 0) return null
  const textFilter = text.length >= 2 ? await matchFilter(cols, text) : null
  return { filter: combinedFilter(textFilter, clauses), cols, text }
}

/** The tab reads' text match runs in the cheap form on the plan's own column types. */
const fastKinds = (p: Pick<PlanEntry, 'collection' | 'kinds'>) =>
  new Map([[p.collection, p.kinds ?? {}]])

/** How many records of each collection match, counted AS THE CALLER (RBAC, row filters,
 *  User Scopes). A collection whose count fails is left out. Exported for tests. */
export async function countMatches(
  user: User,
  readable: string[],
  q: string,
  collections: string[],
  labelsOnly = false
): Promise<
  Array<{ collection: string; display_name: string | null; count: number; capped?: boolean }>
> {
  const parsed = parseSearchQuery(q, await loadSearchScopes())
  const readableSet = new Set(readable)
  const plan = (await buildSearchPlan()).filter(
    (p) =>
      readableSet.has(p.collection) &&
      collections.includes(p.collection) &&
      (!parsed.scope || parsed.scope === p.collection)
  )
  const allowed = await allowedByCollection(user, plan)
  const out: Array<{
    collection: string
    display_name: string | null
    count: number
    capped?: boolean
  }> = []
  for (let i = 0; i < plan.length; i += COUNT_CONCURRENCY) {
    await Promise.all(
      plan.slice(i, i + COUNT_CONCURRENCY).map(async (p) => {
        try {
          const f = await tabFilter(p, parsed, labelsOnly, allowed.get(p.collection) ?? null, user)
          // A text-only search never scans a table over the row budget (a seek-only
          // table's filter is the ids its typed per-column TOP-N seeks found).
          if (!f || (!p.textSearchable && !p.seekOnly && !hasFilterTokens(parsed))) return
          const r = await withFastContains(fastKinds(p), () =>
            readItems(user, p.collection, {
              filter: f.filter,
              fields: ['id'],
              limit: 1
            })
          )
          if (typeof r.total === 'number' && r.total > 0)
            out.push({
              collection: p.collection,
              display_name: p.display_name,
              count: r.total,
              // A big table counts its seek candidates only: "at least" this many.
              ...(f.capped ? { capped: true } : {})
            })
        } catch {
          /* unreadable or the filter was refused — no tab count */
        }
      })
    )
  }
  return out.sort((a, b) => b.count - a.count)
}

/**
 * Second lines that tell rows apart (pure; exported for tests): a hit whose snippet only
 * repeats its label gets the collection's `search_detail` values as the record page
 * shows them ("Line 22 · $2,115.19"). Values come from the caller's own row.
 */
export function withDetail(
  hits: RecordHit[],
  rows: Array<Record<string, unknown>>,
  detail: string[],
  fields: Array<Pick<CMSField, 'field' | 'type'> & Partial<CMSField>>
): RecordHit[] {
  const byId = new Map(rows.map((r) => [String(r.id), r]))
  const meta = new Map(fields.map((f) => [f.field, f]))
  return hits.map((h) => {
    if ((h.snippet ?? '').trim().toLowerCase() !== h.label.trim().toLowerCase()) return h
    const row = byId.get(String(h.id))
    if (!row) return h
    const parts = detail.flatMap((f) => {
      const m = meta.get(f)
      const v = previewValue(m, row[f])
      if (!v) return []
      const label = String((m as { label?: string | null } | undefined)?.label ?? '').trim()
      // "Line 22": a number field reads with its name, money and text by value.
      return [
        /^(integer|bigint|int)$/i.test(String(m?.type ?? '')) ? `${label || detailWord(f)} ${v}` : v
      ]
    })
    return parts.length ? { ...h, snippet: parts.join(' · ').slice(0, 120) } : h
  })
}

const detailWord = (field: string) => {
  const w = field
    .replace(/_(number|no|num)$/i, '')
    .replace(/_item$/i, '')
    .replace(/_/g, ' ')
    .trim()
  return w ? w.charAt(0).toUpperCase() + w.slice(1) : field
}

/** One page of a collection's matches, read as the caller. Exported for tests. */
export async function searchCollectionPage(
  user: User,
  readable: string[],
  q: string,
  collection: string,
  offset: number,
  limit: number,
  labelsOnly = false
): Promise<{ data: RecordHit[]; total: number | null; query?: unknown; capped?: boolean }> {
  if (!readable.includes(collection)) return { data: [], total: 0 }
  const p = (await buildSearchPlan()).find((x) => x.collection === collection)
  if (!p) return { data: [], total: 0 }
  const parsed = parseSearchQuery(q, await loadSearchScopes())
  if (parsed.scope && parsed.scope !== collection) return { data: [], total: 0 }
  const allowed = await getAllowedFields(user, 'read', collection).catch(() => [])
  const f = await tabFilter(p, parsed, labelsOnly, allowed, user)
  if (!f || (!p.textSearchable && !p.seekOnly && !hasFilterTokens(parsed)))
    return { data: [], total: 0 }
  const r = await withFastContains(fastKinds(p), () =>
    readItems(user, collection, {
      filter: f.filter,
      sort: ['-id'],
      offset,
      limit
    })
  )
  const fieldRows = await readableFieldMetas(collection, allowed)
  const labelOf = fieldLabelMap(fieldRows)
  const forms = f.text.length >= 2 ? await searchPhrases(f.text).catch(() => [f.text]) : []
  const data = (r.data as Array<Record<string, unknown>>).map((item) => {
    const hit = forms.length ? toHit(p, item, f.cols, forms, labelOf) : null
    if (hit) {
      const { tier: _t, similarity: _s, createdBy: _c, ...rest } = hideInternalMatch(hit, p)
      return rest as RecordHit
    }
    const matched = matchedText(p, item, f.cols.length ? f.cols : p.columns)
    return {
      collection,
      display_name: p.display_name,
      id: item.id,
      label: hitLabel(p, item, matched),
      snippet: matched.slice(0, 120)
    }
  })
  return {
    // Every record stays its own row on this paged list (paging counts rows); rows that
    // share a label read apart by the collection's `search_detail` fields (army 9 b16).
    data: p.detail?.length
      ? withDetail(
          data,
          r.data as Array<Record<string, unknown>>,
          p.detail,
          await getFields(collection).catch(() => [])
        )
      : data,
    total: typeof r.total === 'number' ? r.total : null,
    ...(f.capped ? { capped: true } : {})
  }
}

/** True when a collection's `browser_config.global_search` is false: it never takes part in
 *  global search (records, exact ids, tab counts and pages, meaning matches, Cmd+K) for anyone
 *  (army 6 D5 — legacy support tickets). Its own list and record pages are unaffected. */
export function excludedFromGlobalSearch(browserConfig: unknown): boolean {
  let cfg: unknown = browserConfig
  if (typeof cfg === 'string') {
    try {
      cfg = JSON.parse(cfg)
    } catch {
      return false
    }
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false
  const v = (cfg as { global_search?: unknown }).global_search
  return v === false || v === 'false' || v === 0
}

/** Registered non-system collections the caller's role may read and global search covers. */
async function readableCollections(user: User): Promise<string[]> {
  const collectionRows = (await db('nivaro_collections').select(
    'collection',
    'browser_config'
  )) as Array<{ collection: string; browser_config: unknown }>
  const candidates = collectionRows
    .filter((c) => !excludedFromGlobalSearch(c.browser_config))
    .map((c) => c.collection)
    .filter((c: string) => !c.toLowerCase().startsWith('nivaro_'))
  if (!user.role) return []
  const role = await db<Role>('nivaro_roles').where({ id: user.role }).first()
  if (role?.admin_access) return candidates
  const policies = await db<Policy>('nivaro_policies').where({ role: user.role, action: 'read' })
  const allowed = new Set(policies.map((p) => p.collection))
  return allowed.has('*') ? candidates : candidates.filter((c) => allowed.has(c))
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function globalSearchRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // GET /?q= — search records, admin pages, and quick actions. The query may carry
  // a prefix scope (`wf: …`, `@…`), field filters (`status:open`), amounts and
  // dates (services/search-query.ts); `data.query` says how it was read.
  app.get('/', async (req, reply) => {
    const { q: rawQ, labels } = req.query as { q?: string; labels?: string }
    const raw = (rawQ ?? '').trim().slice(0, 300)
    // labels=1: match only what each record's label shows (the EFP palette).
    const labelsOnly = labels === '1' || labels === 'true'
    // Typing, retyping and the palette's tab counts repeat one search: the same
    // person with the same access gets the answer computed in the last 20 s
    // (services/search-fts.ts searchAnswerCache, single-flight, per tenant).
    const ws = req.headers['x-workspace']
    const run = () => runGlobalSearch(req, raw, labelsOnly)
    const data = raw
      ? await searchAnswerCache.get(
          {
            user: req.user!,
            q: raw,
            variant: labelsOnly ? 'labels' : '',
            workspace: typeof ws === 'string' ? ws : null
          },
          run
        )
      : await run()
    return reply.send({ data })
  })

  // GET /preview?collection=&id= — the palette's preview pane, read as the caller.
  app.get('/preview', async (req, reply) => {
    const { collection, id } = req.query as { collection?: string; id?: string }
    const c = (collection ?? '').trim()
    const item = (id ?? '').trim()
    if (!IDENT_RE.test(c) || !item || item.length > 100)
      return reply.code(400).send({ error: 'collection and id are required' })
    if (c.toLowerCase().startsWith('nivaro_') || c.toLowerCase().startsWith('directus_'))
      return reply.code(404).send({ error: 'Not found' })
    const data = await buildSearchPreview(req.user as User, c, item, req.isAdmin === true)
    if (!data) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data })
  })

  // GET /preview/linked?collection=&id= — records linked to the previewed one, both ways
  // (a PO's workflows, project, vendor …), read as the caller (services/search-linked.ts).
  app.get('/preview/linked', async (req, reply) => {
    const { collection, id } = req.query as { collection?: string; id?: string }
    const c = (collection ?? '').trim()
    const item = (id ?? '').trim()
    if (!IDENT_RE.test(c) || !item || item.length > 100)
      return reply.code(400).send({ error: 'collection and id are required' })
    if (/^(nivaro_|directus_)/i.test(c)) return reply.code(404).send({ error: 'Not found' })
    const data = await buildSearchLinked(req.user as User, c, item)
    if (!data) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data })
  })

  // GET /labels?refs=col:id,col:id — labels for records search shows without one
  // (pins / recents saved with a pk-only label), read as the caller and batched per
  // collection (services/record-labels-as-viewer.ts). Every ref gets a label, never
  // the pk: its label, else a business id column, else the collection's name.
  app.get('/labels', async (req, reply) => {
    const raw = String((req.query as { refs?: string }).refs ?? '')
    const refs: Array<{ collection: string; id: string }> = []
    for (const part of raw.split(',')) {
      const at = part.indexOf(':')
      if (at <= 0) continue
      const collection = part.slice(0, at).trim()
      const id = part.slice(at + 1).trim()
      if (!IDENT_RE.test(collection) || !id || id.length > 100) continue
      if (/^(nivaro_|directus_)/i.test(collection)) continue
      refs.push({ collection, id })
      if (refs.length >= MAX_LABEL_REFS) break
    }
    if (refs.length === 0) return reply.send({ data: {} })
    const data = await recordLabelsAsViewer(req.user as User, refs)
    return reply.send({ data })
  })

  // POST /click {q, collection, id, position, log_id?} — what was opened from a
  // search; feeds learned ranking (services/search-signals.ts).
  app.post('/click', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const res = await recordClick(String(req.user!.id), body).catch(() => ({
      ok: false,
      log_id: null
    }))
    return reply.send({ data: res })
  })

  // Saved searches — the caller's own, in preferences.saved_searches.
  app.get('/saved', async (req, reply) => {
    return reply.send({ data: await listSavedSearches(String(req.user!.id)) })
  })

  app.post('/saved', async (req, reply) => {
    try {
      const entry = await createSavedSearch(
        String(req.user!.id),
        (req.body ?? {}) as Record<string, unknown>
      )
      return reply.code(201).send({ data: entry })
    } catch (e) {
      if (e instanceof SavedSearchError) return reply.code(e.status).send({ error: e.message })
      throw e
    }
  })

  const deleteSaved = async (id: string, userId: string, reply: import('fastify').FastifyReply) => {
    if (!id) return reply.code(400).send({ error: 'id is required' })
    const ok = await deleteSavedSearch(userId, id.slice(0, 64))
    if (!ok) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data: { ok: true } })
  }
  app.delete('/saved/:id', async (req, reply) =>
    deleteSaved(String((req.params as { id?: string }).id ?? ''), String(req.user!.id), reply)
  )
  app.delete('/saved', async (req, reply) =>
    deleteSaved(String((req.query as { id?: string }).id ?? ''), String(req.user!.id), reply)
  )

  // GET /counts?q=&collections=a,b — each listed collection's match count as the caller
  // (the search's tabs). The palette asks for the collections the first answer found.
  app.get('/counts', async (req, reply) => {
    const {
      q: rawQ,
      collections: rawCols,
      labels
    } = req.query as {
      q?: string
      collections?: string
      labels?: string
    }
    const labelsOnly = labels === '1' || labels === 'true'
    const q = (rawQ ?? '').trim().slice(0, 300)
    const cols = (rawCols ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter((c) => IDENT_RE.test(c))
      .slice(0, 40)
    if (q.length < 2 || cols.length === 0) return reply.send({ data: [] })
    const user = req.user as User
    // A COUNT per collection over contains-LIKEs: an expensive read, so it holds a slot.
    const data = await withReadGate(
      String(user.id),
      async () => countMatches(user, await readableCollections(user), q, cols, labelsOnly),
      { label: 'global-search:counts' }
    )
    return reply.send({ data })
  })

  // GET /records?q=&collection=&offset=&limit= — one collection's matches, a page at a time.
  app.get('/records', async (req, reply) => {
    const query = req.query as {
      q?: string
      collection?: string
      offset?: string
      limit?: string
      labels?: string
    }
    const labelsOnly = query.labels === '1' || query.labels === 'true'
    const q = (query.q ?? '').trim().slice(0, 300)
    const collection = (query.collection ?? '').trim()
    if (q.length < 2 || !IDENT_RE.test(collection)) return reply.send({ data: [], total: 0 })
    const offset = Math.max(0, Math.floor(Number(query.offset) || 0))
    const limit = Math.min(PAGE_MAX, Math.max(1, Math.floor(Number(query.limit) || 25)))
    const user = req.user as User
    try {
      const page = await withReadGate(
        String(user.id),
        async () =>
          searchCollectionPage(
            user,
            await readableCollections(user),
            q,
            collection,
            offset,
            limit,
            labelsOnly
          ),
        { label: 'global-search:records' }
      )
      return reply.send(page)
    } catch {
      return reply.send({ data: [], total: 0 })
    }
  })
}

/** The main search answer for `GET /global-search` (records, people, pages,
 *  actions, semantic, exact, suggestions, query, extra, commands), as the caller. */
async function runGlobalSearch(
  req: FastifyRequest,
  raw: string,
  labelsOnly: boolean
): Promise<Record<string, unknown>> {
  const parsed = parseSearchQuery(raw, await loadSearchScopes().catch(() => ({})))
  const q = parsed.text
  const query: { text: string; scope: string | null; filters: FilterChip[] } = {
    text: q,
    scope: parsed.scopeKey,
    filters: []
  }

  const scoped = parsed.scope != null
  const forms = q.length >= 2 ? await searchPhrases(q).catch(() => [q]) : [q]
  // Pages and actions answer unscoped words only — `wf: settings` means workflows.
  const pages = q && !scoped && !hasFilterTokens(parsed) ? matchStatic(ADMIN_PAGES, forms, 8) : []
  const actions =
    q && !scoped && !hasFilterTokens(parsed) ? matchStatic(QUICK_ACTIONS, forms, 4) : []
  const base = {
    records: [] as RecordHit[],
    people: [] as PersonHit[],
    pages,
    actions,
    semantic: [] as Array<{ collection: string; id: unknown; label: string; snippet: string }>,
    exact: null as RecordHit | null,
    suggestions: [] as string[],
    query
  }

  // `@jane` — people only.
  if (parsed.scope === PEOPLE_SCOPE) {
    const found = q.length >= 1 ? await searchPeople(q, req.isAdmin === true) : []
    const { searchPeopleExtras } = await import('../services/search-extra.js')
    const people = await searchPeopleExtras(req.user as User, q, found, {
      isAdmin: req.isAdmin === true
    }).catch(() => found)
    return { ...base, people }
  }

  if (q.length < 2 && !hasFilterTokens(parsed)) {
    return base
  }

  // Readable collections in one pass (avoid per-collection can() round-trips). The search
  // plan is ready before the budget's clock starts (a rebuild is metadata, not search).
  const user = req.user!
  const [readable] = await Promise.all([
    readableCollections(user as User),
    buildSearchPlan().catch(() => [] as PlanEntry[])
  ])
  // Field metadata — filters, matched-field labels, and the semantic block's labels
  const fieldRows = readable.length
    ? ((await db('nivaro_fields')
        .whereIn('collection', readable)
        .select('collection', 'field', 'type', 'hidden', 'sort', 'label')) as FieldRow[])
    : []

  const byCollection = new Map<string, FieldRow[]>()
  for (const f of fieldRows) {
    const list = byCollection.get(f.collection) ?? []
    list.push(f)
    byCollection.set(f.collection, list)
  }

  // Every part of the answer runs side by side under one time budget
  // (services/search-budget.ts): records (exact ids first), people, meaning
  // matches and the extra kinds. A part still going at the deadline is cut —
  // its statement cancelled on the server — and named in `partial`.
  const budget = new SearchBudget(searchBudgetMs(), SEARCH_CONCURRENCY)
  const plain = !scoped && !hasFilterTokens(parsed)
  const { searchExtra, searchCommands, searchPeopleExtras } = await import(
    '../services/search-extra.js'
  )
  const opts = { isAdmin: req.isAdmin === true, req, budget }
  try {
    const isAdmin = req.isAdmin === true
    const [found, peopleOut, semanticAll, extra] = await Promise.all([
      searchRecords(user as User, readable, parsed, labelsOnly, fieldRows, raw, budget),
      // People, then their role / zones (services/search-people.ts).
      (plain && q.length >= 2
        ? budget.run('people', [] as PersonHit[], () => searchPeople(q, isAdmin))
        : Promise.resolve([] as PersonHit[])
      ).then((people) =>
        searchPeopleExtras(user as User, q, people, { isAdmin }).catch(() => people)
      ),
      q.length >= 4 && plain
        ? budget.run('semantic', [] as SemanticHit[], () =>
            searchSemantic(user as User, q, readable, byCollection)
          )
        : Promise.resolve([] as SemanticHit[]),
      plain ? searchExtra(user as User, q, opts).catch(() => ({})) : Promise.resolve({})
    ])
    const records = found.records
    query.text = found.text
    query.filters = found.chips
    // Meaning matches never repeat a keyword hit.
    const seen = new Set(records.map((r) => `${r.collection}:${String(r.id)}`))
    const semantic = semanticAll
      .filter((h) => !seen.has(`${h.collection}:${String(h.id)}`))
      .slice(0, 8)

    // Confirmable commands (services/search-commands.ts): judged as the caller,
    // never fail the search.
    const commands = await searchCommands(user as User, q, records, opts).catch(() => [])
    // Only parts the search's own deadline cut: parts stopped because an exact id hit
    // already answered (budget.trimmed) are not a failure and raise no warning.
    const partial = [...budget.timedOut]
    const trimmed = [...budget.trimmed].filter((t) => !budget.timedOut.has(t))
    const data: Record<string, unknown> = {
      ...base,
      records,
      people: peopleOut,
      semantic,
      exact: found.exact,
      suggestions: found.suggestions,
      query,
      extra,
      commands,
      // Parts that ran out of time (collection names, or people / semantic /
      // comments / files …): the answer holds everything else.
      ...(partial.length ? { partial } : {}),
      // Parts skipped after an exact id hit — "See all" runs them in full.
      ...(trimmed.length ? { trimmed } : {})
    }
    return data
  } finally {
    budget.finish()
  }
}

type SemanticHit = { collection: string; id: unknown; label: string; snippet: string }

/** Meaning-based matches from the embeddings index (readable, indexed collections
 *  only), confirmed as the caller like the keyword path. */
async function searchSemantic(
  user: User,
  q: string,
  readable: string[],
  byCollection: Map<string, FieldRow[]>
): Promise<SemanticHit[]> {
  const out: SemanticHit[] = []
  try {
    const { embedText, searchEmbeddings } = await import('../services/embeddings.js')
    const indexed = (await db('nivaro_embeddings').distinct('collection').limit(5)) as Array<{
      collection: string
    }>
    const targets = indexed.map((r) => r.collection).filter((c) => readable.includes(c))
    if (targets.length === 0) return []
    const vec = await embedText(q)
    const seen = new Set<string>()
    for (const collection of targets) {
      const hits = (await searchEmbeddings(collection, vec, 4)).filter((h) => h.score > 0.15)
      if (hits.length === 0) continue
      const fields = pickSearchFields(byCollection.get(collection) ?? [])
      const labelField = fields[0] ?? 'id'
      // Confirmed as the caller, like the keyword path: row filter and
      // User Scopes drop hits they cannot open.
      const rows = (
        await readItems(user, collection, {
          filter: { id: { _in: hits.map((h) => h.item) } },
          fields: [...new Set(['id', labelField])],
          limit: hits.length,
          count: false
        }).catch(() => ({ data: [] as unknown[] }))
      ).data as Array<Record<string, unknown>>
      const displayName = rows.length
        ? ((await getCollection(collection).catch(() => undefined))?.display_name ?? null)
        : null
      for (const row of rows) {
        const key = `${collection}:${String(row.id)}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
          collection,
          id: row.id,
          label: safeRecordLabel(labelField === 'id' ? '' : row[labelField], {
            collection,
            id: row.id,
            display_name: displayName
          }).slice(0, 80),
          snippet: 'semantic match'
        })
      }
    }
  } catch {
    return []
  }
  return out
}
