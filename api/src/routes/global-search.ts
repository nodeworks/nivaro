import type { FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { readItems } from '../services/items.js'
import { withReadGate } from '../services/read-gate.js'
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

interface PlanEntry {
  collection: string
  display_name: string | null
  columns: string[]
  /** The columns its label shows (display-template fields, else the first search
   *  column): what a labels-only search (`labels=1`) matches. */
  labelColumns: string[]
  template: string | null
  /** Partition-stat row count — what a contains-LIKE over it costs. */
  rows: number
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const NAMEISH = ['name', 'title', 'label', 'subject']
const MAX_COLS_PER_COLLECTION = 3
const PER_COLLECTION = 8
const RECORD_CAP = 30
// A contains-LIKE is a table scan; multi-million-row tables (invoices 2.7M,
// legacy logs 1.6M) each cost 4-13s and blow the 15s statement timeout for
// the whole union. Tables above this row count are excluded from omnisearch —
// the searchable set stays every collection a person actually types names
// and ids from (workflows, IRs, projects, vendors, units, lines).
const ROW_BUDGET = 500_000

let planCache: { at: number; plan: PlanEntry[] } | null = null

async function buildSearchPlan(): Promise<PlanEntry[]> {
  if (planCache && Date.now() - planCache.at < 60_000) return planCache.plan

  const [collections, stringCols, relations, idTables, rowCounts] = await Promise.all([
    db('nivaro_collections')
      .whereNot('collection', 'like', 'nivaro\\_%')
      .whereNot('collection', 'like', 'directus\\_%')
      .where((qb) => void qb.where('is_virtual', 0).orWhereNull('is_virtual'))
      .select('collection', 'display_name', 'display_template') as Promise<
      Array<{ collection: string; display_name: string | null; display_template: string | null }>
    >,
    db.raw(`
      select table_name, column_name from information_schema.columns
      where data_type in ('nvarchar', 'varchar', 'char', 'nchar')
        and (character_maximum_length between 1 and 2000 or character_maximum_length = -1)
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
  const colsByTable = new Map<string, Set<string>>()
  for (const c of stringCols) {
    const set = colsByTable.get(c.table_name) ?? new Set<string>()
    set.add(c.column_name)
    colsByTable.set(c.table_name, set)
  }

  const plan: PlanEntry[] = []
  for (const col of collections) {
    if (junctions.has(col.collection)) continue
    if (!IDENT_RE.test(col.collection)) continue
    if (!hasId.has(col.collection)) continue
    if ((rowsByTable.get(col.collection) ?? 0) > ROW_BUDGET) continue
    const available = colsByTable.get(col.collection)
    if (!available || !available.size) continue

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
    if (columns.length === 0) continue
    plan.push({
      collection: col.collection,
      display_name: col.display_name,
      columns,
      // A template that shows only non-text fields has no label to match: the
      // collection sits out of a labels-only search. No template: the label is the
      // first search column.
      labelColumns: col.display_template?.trim() ? fromTemplate : columns.slice(0, 1),
      template: col.display_template,
      rows: rowsByTable.get(col.collection) ?? 0
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

type RecordHit = {
  collection: string
  display_name: string | null
  id: unknown
  label: string
  snippet: string
}

/** The columns a search matches: every search column, or (labels-only) just the ones
 *  the record's label shows — so every hit visibly contains what was typed. */
function searchColumns(p: PlanEntry, labelsOnly: boolean): string[] {
  return labelsOnly ? p.labelColumns : p.columns
}

/** A hit's label: the collection's display template over the row, else the matched text. */
function hitLabel(
  p: PlanEntry | undefined,
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

async function searchRecords(
  user: User,
  readable: string[],
  q: string,
  labelsOnly = false
): Promise<RecordHit[]> {
  const readableSet = new Set(readable)
  const plan = (await buildSearchPlan()).filter(
    (p) => readableSet.has(p.collection) && searchColumns(p, labelsOnly).length > 0
  )
  if (plan.length === 0) return []

  // Search synonyms (#1581): the phrase as typed plus its synonym forms. With
  // none (the usual case) the statement is exactly as before; with some, the
  // forms are bound ONCE in a CTE every union member reads, so the parameter
  // count does not multiply by columns × collections.
  const phrases = await searchPhrases(q).catch(() => [q])
  const likes = phrases.map((p) => `%${escapeLike(p)}%`)
  const statement = (batch: PlanEntry[]) => {
    const parts: string[] = []
    const bindings: string[] = []
    for (const p of batch) {
      const cols = searchColumns(p, labelsOnly)
      const casts = cols.map((c) => `CAST([${c}] AS nvarchar(200))`)
      // T-SQL COALESCE demands ≥2 arguments — a single column goes bare.
      const labelExpr = casts.length > 1 ? `COALESCE(${casts.join(', ')})` : casts[0]
      const wheres =
        likes.length > 1
          ? `EXISTS (SELECT 1 FROM nvr_syn s WHERE ${cols.map((c) => `[${c}] LIKE s.p ESCAPE '\\'`).join(' OR ')})`
          : cols.map((c) => `[${c}] LIKE ? ESCAPE '\\'`).join(' OR ')
      // Best matches first within each collection (army 2026-10-25: an exact
      // name came back nowhere because TOP took an arbitrary five): a column
      // equal to the phrase, then one starting with it, then the newest.
      const rank = `CASE WHEN ${cols.map((c) => `[${c}] = ?`).join(' OR ')} THEN 0 WHEN ${cols.map((c) => `[${c}] LIKE ? ESCAPE '\\'`).join(' OR ')} THEN 1 ELSE 2 END`
      parts.push(
        `SELECT * FROM (SELECT TOP ${PER_COLLECTION} '${p.collection}' AS c, CAST(id AS nvarchar(64)) AS id, ${labelExpr} AS label FROM [${p.collection}] WHERE ${wheres} ORDER BY ${rank}, id DESC) AS [s_${p.collection}]`
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
  let candidates: Array<{ c: string; id: string; label: string | null }> = []
  const settled = await Promise.allSettled(
    balanceByRows(plan, SEARCH_BATCHES).map((batch) => {
      const { sql, bindings } = statement(batch)
      return db.raw(sql, bindings) as Promise<typeof candidates>
    })
  )
  for (const r of settled) {
    if (r.status === 'fulfilled') candidates = candidates.concat(r.value)
    else planCache = null // stale plan (dropped table/column) — rebuild next request
  }

  const byCollection = new Map<string, string[]>()
  for (const cand of candidates) {
    const list = byCollection.get(cand.c) ?? []
    if (list.length < PER_COLLECTION) list.push(cand.id)
    byCollection.set(cand.c, list)
  }

  const planByName = new Map(plan.map((p) => [p.collection, p]))
  const results: RecordHit[] = []
  await Promise.all(
    [...byCollection.entries()].map(async ([collection, ids]) => {
      try {
        const p = planByName.get(collection)
        const { data: items } = await readItems(user, collection, {
          filter: { id: { _in: ids } },
          limit: ids.length
        })
        for (const item of items as Array<Record<string, unknown>>) {
          const cand = candidates.find(
            (x) => x.c === collection && String(x.id) === String(item.id)
          )
          results.push({
            collection,
            display_name: p?.display_name ?? null,
            id: item.id,
            label: hitLabel(p, item, String(cand?.label ?? item.id ?? '')),
            snippet: String(cand?.label ?? '').slice(0, 120)
          })
        }
      } catch {
        /* collection unreadable for this user — drop silently */
      }
    })
  )

  const lower = q.toLowerCase()
  if (labelsOnly) {
    // What the person sees must hold what they typed (or a synonym of it).
    const forms = phrases.map((ph) => ph.toLowerCase())
    for (let i = results.length - 1; i >= 0; i--) {
      const label = results[i].label.toLowerCase()
      if (!forms.some((f) => label.includes(f))) results.splice(i, 1)
    }
  }
  const tier = (r: { id: unknown; label: string; snippet: string }) => {
    const label = r.label.toLowerCase()
    const snippet = r.snippet.toLowerCase()
    if (label === lower || snippet === lower || String(r.id) === q) return 0
    if (label.startsWith(lower) || snippet.startsWith(lower)) return 1
    return 2
  }
  results.sort((a, b) => {
    const t = tier(a) - tier(b)
    if (t !== 0) return t
    return a.label.length - b.label.length
  })
  return results.slice(0, RECORD_CAP)
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

/** The items-service filter for "any search column contains the phrase (or a synonym)". */
async function matchFilter(
  p: PlanEntry,
  q: string,
  labelsOnly: boolean
): Promise<Record<string, unknown>> {
  const phrases = await searchPhrases(q).catch(() => [q])
  const cols = searchColumns(p, labelsOnly)
  return { _or: phrases.flatMap((ph) => cols.map((c) => ({ [c]: { _contains: ph } }))) }
}

const COUNT_CONCURRENCY = 4
export const PAGE_MAX = 50

/** How many records of each collection match, counted AS THE CALLER (RBAC, row filters,
 *  User Scopes). A collection whose count fails is left out. Exported for tests. */
export async function countMatches(
  user: User,
  readable: string[],
  q: string,
  collections: string[],
  labelsOnly = false
): Promise<Array<{ collection: string; display_name: string | null; count: number }>> {
  const readableSet = new Set(readable)
  const plan = (await buildSearchPlan()).filter(
    (p) =>
      readableSet.has(p.collection) &&
      collections.includes(p.collection) &&
      searchColumns(p, labelsOnly).length > 0
  )
  const out: Array<{ collection: string; display_name: string | null; count: number }> = []
  for (let i = 0; i < plan.length; i += COUNT_CONCURRENCY) {
    await Promise.all(
      plan.slice(i, i + COUNT_CONCURRENCY).map(async (p) => {
        try {
          const r = await readItems(user, p.collection, {
            filter: await matchFilter(p, q, labelsOnly),
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
): Promise<{ data: RecordHit[]; total: number | null }> {
  if (!readable.includes(collection)) return { data: [], total: 0 }
  const p = (await buildSearchPlan()).find((x) => x.collection === collection)
  if (!p || searchColumns(p, labelsOnly).length === 0) return { data: [], total: 0 }
  const r = await readItems(user, collection, {
    filter: await matchFilter(p, q, labelsOnly),
    sort: ['-id'],
    offset,
    limit
  })
  const data = (r.data as Array<Record<string, unknown>>).map((item) => {
    const matched = matchedText(p, item, searchColumns(p, labelsOnly))
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

  // GET /?q= — search records, admin pages, and quick actions
  app.get('/', async (req, reply) => {
    const { q: rawQ, labels } = req.query as { q?: string; labels?: string }
    const q = (rawQ ?? '').trim()
    // labels=1: match only what each record's label shows (the EFP palette).
    const labelsOnly = labels === '1' || labels === 'true'

    const forms = q.length >= 2 ? await searchPhrases(q).catch(() => [q]) : [q]
    const pages = q ? matchStatic(ADMIN_PAGES, forms, 8) : []
    const actions = q ? matchStatic(QUICK_ACTIONS, forms, 4) : []

    if (q.length < 2) {
      return reply.send({ data: { records: [], people: [], pages, actions } })
    }

    // Readable collections in one pass (avoid per-collection can() round-trips)
    const user = req.user!
    const readable = await readableCollections(user as User)
    // Field metadata — the semantic block below still labels via pickSearchFields
    const fieldRows = readable.length
      ? ((await db('nivaro_fields')
          .whereIn('collection', readable)
          .select('collection', 'field', 'type', 'hidden', 'sort')) as FieldRow[])
      : []

    const byCollection = new Map<string, FieldRow[]>()
    for (const f of fieldRows) {
      const list = byCollection.get(f.collection) ?? []
      list.push(f)
      byCollection.set(f.collection, list)
    }

    const [records, people] = await Promise.all([
      searchRecords(user as User, readable, q, labelsOnly),
      searchPeople(q, req.isAdmin === true)
    ])

    // Semantic hits — meaning-based matches from the embeddings index, deduped
    // against keyword records. Only collections that are both indexed and
    // readable are searched; label resolution goes through a direct id read.
    let semantic: Array<{ collection: string; id: unknown; label: string; snippet: string }> = []
    if (q.length >= 4) {
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

    return reply.send({ data: { records, people, pages, actions, semantic } })
  })

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
    const q = (rawQ ?? '').trim()
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
    const q = (query.q ?? '').trim()
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
