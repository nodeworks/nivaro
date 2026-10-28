import type { FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { readItems } from '../services/items.js'
import { getAllowedFields } from '../services/permissions.js'
import { withReadGate } from '../services/read-gate.js'
import { buildSearchPreview } from '../services/search-preview.js'
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
import type { Policy, Role, User } from '../types.js'

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

/** `browser_config.label_search_fields` (search program item 23), parsed locally:
 *  identifier names only, deduped, capped. Never widens past what the caller may
 *  read — searchColumns intersects with their field list like any column. */
export function parseLabelSearchFields(browserConfig: unknown): string[] {
  try {
    const bc =
      typeof browserConfig === 'string'
        ? (JSON.parse(browserConfig) as Record<string, unknown>)
        : (browserConfig as Record<string, unknown> | null)
    const raw = bc?.label_search_fields
    if (!Array.isArray(raw)) return []
    const names = raw.map((v) => String(v ?? '').trim()).filter((v) => IDENT_RE.test(v))
    return [...new Set(names)].slice(0, MAX_LABEL_SEARCH)
  } catch {
    return []
  }
}

let planCache: { at: number; plan: PlanEntry[] } | null = null

async function buildSearchPlan(): Promise<PlanEntry[]> {
  if (planCache && Date.now() - planCache.at < 60_000) return planCache.plan

  const [collections, stringCols, numericCols, relations, idTables, rowCounts] = await Promise.all([
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
      select table_name, column_name from information_schema.columns
      where data_type in ('nvarchar', 'varchar', 'char', 'nchar')
        and (character_maximum_length between 1 and 2000 or character_maximum_length = -1)
    `) as Promise<Array<{ table_name: string; column_name: string }>>,
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
    db.raw(`select table_name from information_schema.columns where column_name = 'id'`) as Promise<
      Array<{ table_name: string }>
    >,
    // Row counts from partition stats — one query for every table (the
    // config-diff inventory precedent; serial COUNT(*)s took seconds).
    db.raw(`
      select tb.name as table_name, sum(p.rows) as row_count
      from sys.partitions p join sys.tables tb on tb.object_id = p.object_id
      where p.index_id in (0, 1) group by tb.name
    `) as Promise<Array<{ table_name: string; row_count: number | string }>>
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
    const columns = picked.filter((c) => IDENT_RE.test(c)).slice(0, MAX_COLS_PER_COLLECTION)
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
    plan.push({
      collection: col.collection,
      display_name: col.display_name,
      columns: rows <= ROW_BUDGET ? columns : [],
      labelColumns: rows <= ROW_BUDGET ? [...new Set([...baseLabel, ...labelSearch])] : [],
      labelSearch,
      idColumns: rows <= ROW_BUDGET ? idColumns : [],
      numIdColumns: rows <= ROW_BUDGET ? numIdColumns : [],
      template: col.display_template,
      rows,
      textSearchable
    })
  }
  planCache = { at: Date.now(), plan }
  return plan
}

const SEARCH_BATCHES = 4

/** Split the plan into `n` batches of about equal total rows (largest first,
 *  each into the lightest batch so far). Empty batches are dropped. */
export function balanceByRows<T extends { rows: number }>(plan: T[], n: number): T[][] {
  const bins = Array.from({ length: Math.max(1, n) }, () => ({ rows: 0, items: [] as T[] }))
  for (const p of [...plan].sort((a, b) => b.rows - a.rows)) {
    const bin = bins.reduce((lo, b) => (b.rows < lo.rows ? b : lo))
    bin.items.push(p)
    bin.rows += p.rows
  }
  return bins.map((b) => b.items).filter((items) => items.length > 0)
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

/** A hit's label: the collection's display template over the row, else the matched text. */
function hitLabel(
  p: Pick<PlanEntry, 'template'> | undefined,
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
  return label.slice(0, 80)
}

/** The first plan column holding a value, for a hit found by the items service. */
function matchedText(p: PlanEntry, item: Record<string, unknown>, cols = p.columns): string {
  for (const c of cols) {
    const v = item[c]
    if (v != null && typeof v !== 'object' && String(v).trim()) return String(v)
  }
  return String(item.id ?? '')
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

function groupCandidates(rows: Array<{ c: string; id: string }>, cap: number) {
  const by = new Map<string, string[]>()
  for (const r of rows) {
    const list = by.get(r.c) ?? []
    if (list.length < cap && !list.includes(r.id)) list.push(r.id)
    by.set(r.c, list)
  }
  return by
}

/** Run batched raw candidate statements side by side; a failed batch drops the plan cache. */
async function runBatches(
  stmts: Array<{ sql: string; bindings: unknown[] }>
): Promise<Array<{ c: string; id: string }>> {
  let rows: Array<{ c: string; id: string }> = []
  const settled = await Promise.allSettled(
    stmts.map((s) => db.raw(s.sql, s.bindings as never) as Promise<typeof rows>)
  )
  for (const r of settled) {
    if (r.status === 'fulfilled') rows = rows.concat(r.value)
    else planCache = null // stale plan (dropped table/column) — rebuild next request
  }
  return rows
}

interface SearchCtx {
  user: User
  labelsOnly: boolean
  allowed: Map<string, string[] | null>
  labelOf: LabelOf
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
  const statement = (batch: PlanEntry[]) => {
    const parts: string[] = []
    const bindings: string[] = []
    for (const p of batch) {
      const cols = colsOf(p)
      const wheres =
        likes.length > 1
          ? `EXISTS (SELECT 1 FROM nvr_syn s WHERE ${cols.map((c) => `[${c}] LIKE s.p ESCAPE '\\'`).join(' OR ')})`
          : cols.map((c) => `[${c}] LIKE ? ESCAPE '\\'`).join(' OR ')
      // Best matches first within each collection (army 2026-10-25: an exact
      // name came back nowhere because TOP took an arbitrary five): a column
      // equal to the phrase, then one starting with it, then the newest.
      const rank = `CASE WHEN ${cols.map((c) => `[${c}] = ?`).join(' OR ')} THEN 0 WHEN ${cols.map((c) => `[${c}] LIKE ? ESCAPE '\\'`).join(' OR ')} THEN 1 ELSE 2 END`
      parts.push(
        `SELECT * FROM (SELECT TOP ${perCollection} '${p.collection}' AS c, CAST(id AS nvarchar(64)) AS id FROM [${p.collection}] WHERE ${wheres} ORDER BY ${rank}, id DESC) AS [s_${p.collection}]`
      )
      if (likes.length === 1) bindings.push(...cols.map(() => likes[0]))
      bindings.push(...cols.map(() => q), ...cols.map(() => `${escapeLike(q)}%`))
    }
    const cte =
      likes.length > 1
        ? `WITH nvr_syn(p) AS (${likes.map(() => 'SELECT CAST(? AS nvarchar(410))').join(' UNION ALL ')}) `
        : ''
    if (cte) bindings.unshift(...likes)
    return { sql: cte + parts.join(' UNION ALL '), bindings }
  }

  // The arms of one UNION run one after another (~2.5 s on EFP: workflows,
  // units and the two line tables are 0.4–0.6 s each), so they go out as a few
  // row-balanced statements side by side instead — the answer waits for the
  // slowest batch, and a search holds at most SEARCH_BATCHES connections.
  const candidatesRows = await runBatches(balanceByRows(plan, SEARCH_BATCHES).map(statement))
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

/**
 * Exact-id pass (item 1): an id-ish query equal to a business-id column of a
 * collection (string `*_id` / `*_number`, numeric `*_number` for digits), or —
 * scoped — the record's own `id`. Readable columns only; every candidate is
 * re-read as the caller and must still show that exact value. Exported for tests
 * of the statement shape via `exactStatement`.
 */
export function exactStatement(
  batch: Array<{ collection: string; cols: string[]; nums: string[] }>,
  q: string
): { sql: string; bindings: unknown[] } | null {
  const parts: string[] = []
  const bindings: unknown[] = []
  const digits = /^\d{1,15}$/.test(q)
  for (const b of batch) {
    const nums = digits ? b.nums : []
    const preds = [...b.cols.map((c) => `[${c}] = ?`), ...nums.map((c) => `[${c}] = ?`)]
    if (preds.length === 0) continue
    parts.push(
      `SELECT * FROM (SELECT TOP 2 '${b.collection}' AS c, CAST(id AS nvarchar(64)) AS id FROM [${b.collection}] WHERE ${preds.join(' OR ')}) AS [x_${b.collection}]`
    )
    bindings.push(...b.cols.map(() => q), ...nums.map(() => Number(q)))
  }
  return parts.length ? { sql: parts.join(' UNION ALL '), bindings } : null
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
        nums: readableOnly(p.numIdColumns, allowed)
      }
    })
    .filter((s) => s.cols.length + s.nums.length > 0)
  const stmts = balanceByRows(specs, 2)
    .map((batch) => exactStatement(batch, q))
    .filter((s): s is { sql: string; bindings: unknown[] } => s != null)
  const [found, byId] = await Promise.all([
    runBatches(stmts),
    // Scoped: the record's own id. A primary-key seek, so any table size; its
    // own statement — an id type clash (uuid vs digits) fails only this one.
    scope && candidates.some((p) => p.collection === scope)
      ? (
          db.raw(
            `SELECT TOP 1 '${scope}' AS c, CAST(id AS nvarchar(64)) AS id FROM [${scope}] WHERE [id] = ?`,
            [/^\d{1,15}$/.test(q) ? Number(q) : q]
          ) as Promise<Array<{ c: string; id: string }>>
        ).catch(() => [])
      : Promise.resolve([] as Array<{ c: string; id: string }>)
  ])
  const rows = await confirmRows(ctx.user, groupCandidates([...byId, ...found], 2))
  const lower = q.toLowerCase()
  const out: Found[] = []
  for (const [collection, items] of rows) {
    const spec = specs.find((s) => s.collection === collection)
    const p = spec?.p ?? candidates.find((c) => c.collection === collection)
    if (!p) continue
    const idReadable = readableOnly(['id'], ctx.allowed.get(collection)).length > 0
    for (const item of items) {
      let col = [...(spec?.cols ?? []), ...(spec?.nums ?? [])].find(
        (c) => item[c] != null && String(item[c]).toLowerCase() === lower
      )
      if (!col && scope === collection && idReadable && String(item.id).toLowerCase() === lower)
        col = 'id'
      if (!col) continue
      const value = String(item[col])
      out.push(
        withRowFacts(
          {
            collection,
            display_name: p.display_name,
            id: item.id,
            label: hitLabel(p, item, value),
            snippet: value.slice(0, 120),
            matched_field: col,
            matched_label: ctx.labelOf(collection, col),
            matched_value: value.slice(0, 80),
            exact: true,
            tier: 'exact'
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
  batch: Array<{ collection: string; cols: string[] }>,
  q: string
): { sql: string; bindings: string[] } | null {
  const { chunks, need } = fuzzyChunks(q)
  if (chunks.length < 2) return null
  const parts: string[] = []
  const bindings: string[] = []
  for (const b of batch) {
    if (b.cols.length === 0) continue
    const sums = b.cols.map(
      (c, i) =>
        `(${chunks.map(() => `CASE WHEN t.[${c}] LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END`).join(' + ')}) AS s${i}`
    )
    const where = b.cols.map((_, i) => `x.s${i} >= ${need}`).join(' OR ')
    const best = b.cols.length > 1 ? `CASE WHEN x.s0 >= x.s1 THEN x.s0 ELSE x.s1 END` : 'x.s0'
    parts.push(
      `SELECT * FROM (SELECT TOP ${FUZZY_PER_COLLECTION} '${b.collection}' AS c, CAST(t.id AS nvarchar(64)) AS id FROM [${b.collection}] AS t CROSS APPLY (SELECT ${sums.join(', ')}) AS x WHERE ${where} ORDER BY ${best} DESC, t.id DESC) AS [f_${b.collection}]`
    )
    for (const _c of b.cols) bindings.push(...chunks.map((ch) => `%${escapeLike(ch)}%`))
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
        cols: (named.length ? named : cols).slice(0, 2)
      }
    })
    .filter((s) => s.cols.length > 0)
  const stmts = balanceByRows(specs, SEARCH_BATCHES)
    .map((batch) => fuzzyStatement(batch, q))
    .filter((s): s is { sql: string; bindings: string[] } => s != null)
  if (stmts.length === 0) return []
  const rows = await confirmRows(
    ctx.user,
    groupCandidates(await runBatches(stmts), FUZZY_PER_COLLECTION)
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
          const r = await readItems(ctx.user, p.collection, {
            filter: combinedFilter(text ? phraseFilter(cols, phrases) : null, clauses),
            sort: ['-id'],
            limit: perCollection,
            count: false
          })
          for (const item of r.data as Array<Record<string, unknown>>) {
            if (text) {
              const hit = toHit(p, item, cols, forms, ctx.labelOf)
              if (hit) out.push(hit)
              continue
            }
            // Filters only: the hit is "matched" by its first filter field.
            const f = chips.find((c) => c.field in item)?.field
            const value = f != null && item[f] != null ? String(item[f]) : ''
            const label = hitLabel(
              p,
              item,
              matchedText(p, item, p.columns.length ? p.columns : ['id'])
            )
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

/** Everything the record half of one search does. */
async function searchRecords(
  user: User,
  readable: string[],
  parsed: ParsedQuery,
  labelsOnly: boolean,
  fieldRows: FieldRow[],
  /** The query as typed — what the palette logs, so what learned ranking keys on. */
  raw: string
): Promise<RecordSearchResult> {
  const readableSet = new Set(readable)
  const scope = parsed.scope && parsed.scope !== PEOPLE_SCOPE ? parsed.scope : null
  let plan = (await buildSearchPlan()).filter((p) => readableSet.has(p.collection))
  if (scope) plan = plan.filter((p) => p.collection === scope)
  const empty = { records: [], exact: null, chips: [], text: parsed.text, suggestions: [] }
  if (plan.length === 0) return empty
  const allowed = await allowedByCollection(user, plan)
  const ctx: SearchCtx = { user, labelsOnly, allowed, labelOf: fieldLabelMap(fieldRows) }

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
    !filtering && looksLikeId(text)
      ? searchExact(ctx, plan, text, scope)
      : Promise.resolve([] as Found[])
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
  const [learned, recent, owned] = await Promise.all([
    learnedOpens(raw).catch(() => new Map<string, number>()),
    recentOpens(String(user.id)).catch(() => new Set<string>()),
    ownedAmong(String(user.id), byCollection).catch(() => new Set<string>())
  ])
  const records = finishHits(found, { userId: String(user.id), learned, recent, owned })
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
  allowed: string[] | null
): Promise<{ filter: Record<string, unknown>; cols: string[]; text: string } | null> {
  const fields = await readableFieldMetas(p.collection, allowed)
  const metas = new Map([
    [
      p.collection,
      fields.map((f) => ({ field: f.field, label: f.label ?? null, type: String(f.type ?? '') }))
    ]
  ])
  // A tab is one collection: its amounts and dates resolve there, like a scope.
  const plan = planFilters(parsed, metas, { scope: p.collection })
  const cols = searchColumns(p, labelsOnly, allowed)
  const clauses = plan.targets?.get(p.collection) ?? []
  const text = plan.text
  if (text.length >= 2 && cols.length === 0) return null
  if (text.length < 2 && clauses.length === 0) return null
  const textFilter = text.length >= 2 ? await matchFilter(cols, text) : null
  return { filter: combinedFilter(textFilter, clauses), cols, text }
}

/** How many records of each collection match, counted AS THE CALLER (RBAC, row filters,
 *  User Scopes). A collection whose count fails is left out. Exported for tests. */
export async function countMatches(
  user: User,
  readable: string[],
  q: string,
  collections: string[],
  labelsOnly = false
): Promise<Array<{ collection: string; display_name: string | null; count: number }>> {
  const parsed = parseSearchQuery(q, await loadSearchScopes())
  const readableSet = new Set(readable)
  const plan = (await buildSearchPlan()).filter(
    (p) =>
      readableSet.has(p.collection) &&
      collections.includes(p.collection) &&
      (!parsed.scope || parsed.scope === p.collection)
  )
  const allowed = await allowedByCollection(user, plan)
  const out: Array<{ collection: string; display_name: string | null; count: number }> = []
  for (let i = 0; i < plan.length; i += COUNT_CONCURRENCY) {
    await Promise.all(
      plan.slice(i, i + COUNT_CONCURRENCY).map(async (p) => {
        try {
          const f = await tabFilter(p, parsed, labelsOnly, allowed.get(p.collection) ?? null)
          // A text-only search never scans a table over the row budget.
          if (!f || (!p.textSearchable && !hasFilterTokens(parsed))) return
          const r = await readItems(user, p.collection, {
            filter: f.filter,
            fields: ['id'],
            limit: 1
          })
          if (typeof r.total === 'number' && r.total > 0)
            out.push({ collection: p.collection, display_name: p.display_name, count: r.total })
        } catch {
          /* unreadable or the filter was refused — no tab count */
        }
      })
    )
  }
  return out.sort((a, b) => b.count - a.count)
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
): Promise<{ data: RecordHit[]; total: number | null; query?: unknown }> {
  if (!readable.includes(collection)) return { data: [], total: 0 }
  const p = (await buildSearchPlan()).find((x) => x.collection === collection)
  if (!p) return { data: [], total: 0 }
  const parsed = parseSearchQuery(q, await loadSearchScopes())
  if (parsed.scope && parsed.scope !== collection) return { data: [], total: 0 }
  const allowed = await getAllowedFields(user, 'read', collection).catch(() => [])
  const f = await tabFilter(p, parsed, labelsOnly, allowed)
  if (!f || (!p.textSearchable && !hasFilterTokens(parsed))) return { data: [], total: 0 }
  const r = await readItems(user, collection, {
    filter: f.filter,
    sort: ['-id'],
    offset,
    limit
  })
  const fieldRows = await readableFieldMetas(collection, allowed)
  const labelOf = fieldLabelMap(fieldRows)
  const forms = f.text.length >= 2 ? await searchPhrases(f.text).catch(() => [f.text]) : []
  const data = (r.data as Array<Record<string, unknown>>).map((item) => {
    const hit = forms.length ? toHit(p, item, f.cols, forms, labelOf) : null
    if (hit) {
      const { tier: _t, similarity: _s, createdBy: _c, ...rest } = hit
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
  return { data, total: typeof r.total === 'number' ? r.total : null }
}

/** Registered non-system collections the caller's role may read. */
async function readableCollections(user: User): Promise<string[]> {
  const collectionRows = await db('nivaro_collections').select('collection')
  const candidates = collectionRows
    .map((c: { collection: string }) => c.collection)
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
      return reply.send({ data: { ...base, people } })
    }

    if (q.length < 2 && !hasFilterTokens(parsed)) {
      return reply.send({ data: base })
    }

    // Readable collections in one pass (avoid per-collection can() round-trips)
    const user = req.user!
    const readable = await readableCollections(user as User)
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

    const [found, people] = await Promise.all([
      searchRecords(user as User, readable, parsed, labelsOnly, fieldRows, raw),
      !scoped && !hasFilterTokens(parsed) && q.length >= 2
        ? searchPeople(q, req.isAdmin === true)
        : Promise.resolve([] as PersonHit[])
    ])
    const records = found.records
    query.text = found.text
    query.filters = found.chips

    // Semantic hits — meaning-based matches from the embeddings index, deduped
    // against keyword records. Only collections that are both indexed and
    // readable are searched; label resolution goes through a direct id read.
    let semantic: Array<{ collection: string; id: unknown; label: string; snippet: string }> = []
    if (q.length >= 4 && !scoped && !hasFilterTokens(parsed)) {
      try {
        const { embedText, searchEmbeddings } = await import('../services/embeddings.js')
        const indexed = (await db('nivaro_embeddings').distinct('collection').limit(5)) as Array<{
          collection: string
        }>
        const targets = indexed.map((r) => r.collection).filter((c) => readable.includes(c))
        if (targets.length > 0) {
          const vec = await embedText(q)
          const seen = new Set(records.map((r) => `${r.collection}:${String(r.id)}`))
          for (const collection of targets) {
            const hits = (await searchEmbeddings(collection, vec, 4)).filter((h) => h.score > 0.15)
            if (hits.length === 0) continue
            const fields = pickSearchFields(byCollection.get(collection) ?? [])
            const labelField = fields[0] ?? 'id'
            // Confirmed as the caller, like the keyword path: row filter and
            // User Scopes drop hits they cannot open.
            const rows = (
              await readItems(user as User, collection, {
                filter: { id: { _in: hits.map((h) => h.item) } },
                fields: [...new Set(['id', labelField])],
                limit: hits.length,
                count: false
              }).catch(() => ({ data: [] as unknown[] }))
            ).data as Array<Record<string, unknown>>
            for (const row of rows) {
              const key = `${collection}:${String(row.id)}`
              if (seen.has(key)) continue
              seen.add(key)
              semantic.push({
                collection,
                id: row.id,
                label: String(row[labelField] ?? row.id).slice(0, 80),
                snippet: 'semantic match'
              })
            }
          }
          semantic = semantic.slice(0, 8)
        }
      } catch {
        semantic = []
      }
    }

    // Extra kinds (comments/notes/files/videos/docs/chat/config), confirmable
    // commands and people role/zones (services/search-extra.ts). Each part judges
    // its own hits as the caller and never fails the search. Unscoped words only:
    // `wf: …` and field filters ask for records.
    const plain = !scoped && !hasFilterTokens(parsed)
    const { searchExtra, searchCommands, searchPeopleExtras } = await import(
      '../services/search-extra.js'
    )
    const opts = { isAdmin: req.isAdmin === true, req }
    const [extra, commands, peopleOut] = await Promise.all([
      plain ? searchExtra(user as User, q, opts).catch(() => ({})) : Promise.resolve({}),
      searchCommands(user as User, q, records, opts).catch(() => []),
      searchPeopleExtras(user as User, q, people, { isAdmin: req.isAdmin === true }).catch(
        () => people
      )
    ])

    const data: Record<string, unknown> = {
      ...base,
      records,
      people: peopleOut,
      semantic,
      exact: found.exact,
      suggestions: found.suggestions,
      query,
      extra,
      commands
    }
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
