/**
 * Typo tolerance for record pickers (army 11, Rob: "all deferred code fixed").
 *
 * Global search forgives a typo ("Kristna" finds Kristina) through its trigram pass
 * (routes/global-search.ts fuzzyStatement); a record picker's read (`GET /items/:c?picker=1
 * &search=`) did not — one wrong letter and the list was empty. Opt-in with `typo=1`:
 * when the plain search found NOTHING on the first page, the same typo pass runs over the
 * picker's display fields, and its candidates are read again through the items service AS
 * THE CALLER with the picker's own filter — row filters, User Scopes, picker exclusions
 * and the people-picker rules all apply exactly as on the plain read. Matches come back
 * best first, each flagged `fuzzy: true`, with `meta.fuzzy: true`.
 *
 * Bounded: one statement under its own time budget (cancelled on the server past it),
 * tables up to TYPO_ROW_LIMIT rows only, at most two display columns, never a credential
 * or another system's id column.
 */
import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { fuzzyStatement } from '../routes/global-search.js'
import type { ItemsQuery, User } from '../types.js'
import { tenantState } from './ai-tenant-state.js'
import { getCollection } from './collections.js'
import { getAllowedFields } from './permissions.js'
import { searchAccessClause } from './search-access.js'
import { SearchBudget } from './search-budget.js'
import { searchInternalFieldsOf } from './search-fields.js'
import { type TextKind, textKindOf } from './search-like.js'
import { FUZZY_MIN_SIMILARITY, similarity, wantsFuzzy } from './search-rank.js'
import { systemReadableColumns } from './system-collections.js'

/** The typo statement's own time budget (the picker read already spent some). */
export const PICKER_TYPO_BUDGET_MS = 1200
/** Candidates the typo statement keeps. */
export const PICKER_TYPO_TOP = 12
/** Tables bigger than this never get the typo scan (several LIKEs per row). */
export const TYPO_ROW_LIMIT = 200_000
/** What a people picker's typo pass reads: who they are, nothing stored about them. */
const PEOPLE_COLS = ['first_name', 'last_name', 'email']
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const NEVER = /password|token|secret|totp|external_id/i
const FACTS_TTL_MS = 60_000

export interface TableFacts {
  rows: number
  kinds: Record<string, TextKind>
}

const factsCache = tenantState(() => new Map<string, { at: number; facts: TableFacts | null }>())

/** String columns (with their text kind) and the row count of one table; null off SQL
 *  Server or when the table cannot be read. Cached a minute per tenant. */
export async function tableFacts(collection: string): Promise<TableFacts | null> {
  const cache = factsCache()
  const hit = cache.get(collection)
  if (hit && Date.now() - hit.at < FACTS_TTL_MS) return hit.facts
  let facts: TableFacts | null = null
  try {
    const [cols, count] = await Promise.all([
      db.raw(
        `SELECT c.name AS column_name, ty.name AS data_type FROM sys.columns c
         JOIN sys.types ty ON ty.user_type_id = c.user_type_id
         WHERE c.object_id = OBJECT_ID(?) AND ty.name IN ('nvarchar', 'varchar', 'nchar', 'char')`,
        [collection]
      ) as Promise<Array<{ column_name: string; data_type: string }>>,
      db.raw(
        `SELECT SUM(p.rows) AS n FROM sys.partitions p
         WHERE p.object_id = OBJECT_ID(?) AND p.index_id IN (0, 1)`,
        [collection]
      ) as Promise<Array<{ n: number | string | null }>>
    ])
    const kinds: Record<string, TextKind> = {}
    for (const c of cols ?? []) kinds[c.column_name] = textKindOf(c.data_type)
    facts = { rows: Number(count?.[0]?.n ?? 0), kinds }
  } catch {
    facts = null
  }
  if (cache.size > 2000) cache.clear()
  cache.set(collection, { at: Date.now(), facts })
  return facts
}

/**
 * The picker's display columns the typo pass reads (pure; exported for tests): the
 * top-level fields the picker asked for (its display template), else the collection's
 * template; text columns only, readable by the caller, never a credential, never another
 * system's id (`search_internal_fields`). People pickers read name and email only. At
 * most two (the typo statement compares two).
 */
export function pickerTypoColumns(args: {
  collection: string
  fields?: string[] | null
  template?: string | null
  textColumns: ReadonlySet<string>
  allowed: readonly string[] | null
  internal?: readonly string[]
  isAdmin?: boolean
}): string[] {
  const { collection } = args
  const system = /^(nivaro_|directus_)/i.test(collection)
  if (system && collection.toLowerCase() !== 'nivaro_users') return []
  const fromFields = (args.fields ?? [])
    .map((f) => f.trim())
    .filter((f) => f && !f.includes('.') && f !== '*' && f !== 'id')
  const fromTemplate = [...(args.template ?? '').matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map(
    (m) => m[1]
  )
  const wanted = [...new Set(fromFields.length ? fromFields : fromTemplate)]
  const readable = (c: string) =>
    args.allowed == null || args.allowed.includes('*') || args.allowed.includes(c)
  return wanted
    .filter(
      (c) =>
        IDENT_RE.test(c) &&
        !NEVER.test(c) &&
        args.textColumns.has(c) &&
        !(args.internal ?? []).includes(c) &&
        readable(c) &&
        (!system || PEOPLE_COLS.includes(c))
    )
    .slice(0, 2)
}

/** Candidate ids from the typo statement, best first ([] when it does not apply, runs
 *  out of time or fails). */
export async function pickerTypoIds(
  user: User,
  collection: string,
  q: string,
  opts: { fields?: string[] | null; isAdmin?: boolean; budgetMs?: number } = {}
): Promise<string[]> {
  if (!IDENT_RE.test(collection) || !wantsFuzzy(q)) return []
  const facts = await tableFacts(collection)
  if (!facts || facts.rows > TYPO_ROW_LIMIT) return []
  const col = await getCollection(collection).catch(() => null)
  const people = collection.toLowerCase() === 'nivaro_users'
  const allowed = people
    ? opts.isAdmin
      ? null
      : (systemReadableColumns(collection) ?? [])
    : await getAllowedFields(user, 'read', collection).catch(() => [] as string[])
  const cols = pickerTypoColumns({
    collection,
    fields: opts.fields,
    template: (col as { display_template?: string | null } | null)?.display_template ?? null,
    textColumns: new Set(Object.keys(facts.kinds)),
    allowed,
    internal: searchInternalFieldsOf((col as { browser_config?: unknown } | null)?.browser_config),
    isAdmin: opts.isAdmin
  })
  if (cols.length === 0) return []
  const access = await searchAccessClause(user, collection).catch(() => null)
  const stmt = fuzzyStatement(
    [{ collection, cols, kinds: facts.kinds, access }],
    q,
    undefined,
    PICKER_TYPO_TOP
  )
  if (!stmt) return []
  const budget = new SearchBudget(opts.budgetMs ?? PICKER_TYPO_BUDGET_MS, 1)
  try {
    const rows = await budget
      .runQuery<{ id: string }>('picker-typo', stmt.sql, stmt.bindings)
      .catch(() => [] as Array<{ id: string }>)
    return [...new Set(rows.map((r) => String(r.id)))]
  } finally {
    budget.finish()
  }
}

type ReadFn = (query: ItemsQuery) => Promise<{ data: unknown[]; meta?: Record<string, unknown> }>

/**
 * Re-read typo candidates through the items service as the caller (`read` = readItems
 * with the picker's own user/request), keep those that still look like the query
 * (FUZZY_MIN_SIMILARITY on a display column), best first, flagged `fuzzy: true`.
 * Exported for tests.
 */
export async function readTypoMatches(
  query: ItemsQuery,
  ids: string[],
  cols: string[],
  q: string,
  read: ReadFn
): Promise<{ data: Array<Record<string, unknown>>; meta: Record<string, unknown> } | null> {
  if (ids.length === 0) return null
  const byIds = { id: { _in: ids } }
  const {
    search: _s,
    search_fields: _f,
    search_rank: _r,
    after: _a,
    page: _p,
    ...rest
  } = query as ItemsQuery & { search_rank?: unknown; after?: unknown; page?: unknown }
  const res = await read({
    ...rest,
    filter: query.filter ? { _and: [query.filter, byIds] } : byIds,
    offset: 0,
    limit: ids.length
  } as ItemsQuery)
  const order = new Map(ids.map((id, i) => [id, i]))
  const scored = (res.data as Array<Record<string, unknown>>)
    .map((row) => {
      const sim = Math.max(
        0,
        ...cols.map((c) =>
          row[c] == null || typeof row[c] === 'object' ? 0 : similarity(q, String(row[c]))
        )
      )
      return { row, sim }
    })
    .filter((x) => cols.length === 0 || x.sim >= FUZZY_MIN_SIMILARITY)
    .sort(
      (a, b) =>
        b.sim - a.sim || (order.get(String(a.row.id)) ?? 0) - (order.get(String(b.row.id)) ?? 0)
    )
  if (scored.length === 0) return null
  return {
    data: scored.map((x) => ({ ...x.row, fuzzy: true })),
    meta: { ...(res.meta ?? {}), total: scored.length, filter_count: scored.length, fuzzy: true }
  }
}

/** The whole opt-in pass for one picker read that found nothing. Null = keep the empty answer. */
export async function pickerTypoRead(
  user: User,
  collection: string,
  query: ItemsQuery,
  req: FastifyRequest,
  read: ReadFn
): Promise<{ data: Array<Record<string, unknown>>; meta: Record<string, unknown> } | null> {
  const q = String(query.search ?? '').trim()
  if (!q) return null
  const isAdmin = (req as { isAdmin?: boolean }).isAdmin === true
  const ids = await pickerTypoIds(user, collection, q, { fields: query.fields, isAdmin })
  if (ids.length === 0) return null
  // The columns compared again in JS: the same rule the statement used.
  const facts = await tableFacts(collection)
  const col = await getCollection(collection).catch(() => null)
  const cols = pickerTypoColumns({
    collection,
    fields: query.fields,
    template: (col as { display_template?: string | null } | null)?.display_template ?? null,
    textColumns: new Set(Object.keys(facts?.kinds ?? {})),
    allowed: null,
    isAdmin
  })
  return readTypoMatches(query, ids, cols, q, read)
}
