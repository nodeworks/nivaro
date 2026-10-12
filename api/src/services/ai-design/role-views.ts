import { createHash } from 'node:crypto'
import { db } from '../../db/index.js'
import { hasColumn } from '../../lib/column-probe.js'
import { selectInChunks } from '../db-batch.js'
import { type AiComplete, asArray, cleanText, parseJsonLoose, titleCase } from './model.js'

/**
 * Suggested saved views per role (#1965).
 *
 * The signal is the API log: every list a person filters by hand in a
 * collection browser is a `GET /api/items/:collection?conditions=[…]` row
 * (session auth). The same filter set coming back — from several people in
 * one role, or from one person on several days — is a view that role is
 * missing. Each suggestion carries the filters as the browser's own filter
 * chips, the sort people used most, and how many members of the role
 * applied it; the model (optional) only names it and picks columns from the
 * collection's real fields. Filter sets a shared view visible to that role
 * already holds are left out.
 *
 * Nothing is created until an admin accepts a suggestion, which writes one
 * shared, role-scoped `nivaro_saved_views` row.
 */

export interface LoggedCondition {
  path: string[]
  op: string
  value: unknown
}

export interface FilterUse {
  user: string
  collection: string
  conditions: LoggedCondition[]
  sort: string | null
  day: string
}

export interface RoleViewSuggestion {
  id: string
  role: { id: string; name: string; members: number }
  collection: string
  collection_label: string
  conditions: LoggedCondition[]
  filters: ActiveFilterLike[]
  sort: string | null
  columns: string[] | null
  name: string
  description: string | null
  /** Distinct members of the role who applied this filter set by hand. */
  people: number
  /** Distinct person-days it was applied. */
  uses: number
}

/** The browser's filter-chip shape (packages/shared CollectionBrowserView ActiveFilter). */
export interface ActiveFilterLike {
  id: string
  path: string[]
  pathLabels: string[]
  fieldType: string
  op: string
  value: string | Array<string | number>
  relTarget?: string
}

export const DEFAULT_DAYS = 14
const LOG_ROW_CAP = 20000
const MAX_SUGGESTIONS = 25
const MIN_PEOPLE = 2
const MIN_DAYS_ONE_PERSON = 3
/** A one-person habit is only shown for roles at least this big — in a
 *  smaller role it would single that person out. */
const MIN_MEMBERS_FOR_ONE_PERSON = 3

// ── Parsing the log ───────────────────────────────────────────────────────────

/**
 * One logged list request → the filter set it applied. Null for anything
 * that is not a plain collection list (an item read, a `$` pseudo-field, an
 * OR group) — a view could not reproduce those exactly.
 */
export function parseItemsRequest(
  path: string,
  query: string | null
): { collection: string; conditions: LoggedCondition[]; sort: string | null } | null {
  const m = String(path ?? '').match(/^\/api\/items\/([^/?]+)\/?$/)
  if (!m || !query) return null
  const collection = decodeSafe(m[1])
  if (!collection || /^(nivaro|directus)_/i.test(collection)) return null
  let params: URLSearchParams
  try {
    params = new URLSearchParams(query)
  } catch {
    return null
  }
  const raw = params.get('conditions')
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 12) return null
  const conditions: LoggedCondition[] = []
  for (const c of parsed) {
    const o = c as { path?: unknown; op?: unknown; value?: unknown }
    if (!o || typeof o !== 'object' || !Array.isArray(o.path) || typeof o.op !== 'string')
      return null
    const p = o.path.map(String)
    if (p.length === 0 || p.some((s) => !s || s.startsWith('$'))) return null
    conditions.push({ path: p, op: o.op, value: o.value ?? null })
  }
  const sort = cleanText(params.get('sort'), 120)
  return { collection, conditions, sort }
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function normValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => String(x)).sort()
  if (v == null) return null
  return String(v)
}

/** Order-insensitive key for a filter set: same filters = same view. */
export function conditionSignature(conditions: LoggedCondition[]): string {
  const parts = conditions
    .map((c) => JSON.stringify([c.path.join('.'), c.op, normValue(c.value)]))
    .sort()
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16)
}

// ── Aggregating ───────────────────────────────────────────────────────────────

export interface RoleFilterCluster {
  role: string
  collection: string
  signature: string
  conditions: LoggedCondition[]
  sort: string | null
  people: number
  uses: number
}

/**
 * Group uses by (role, collection, filter set). A cluster counts when at
 * least MIN_PEOPLE members applied it, or one member applied it on
 * MIN_DAYS_ONE_PERSON separate days.
 */
export function clusterRoleFilters(
  uses: FilterUse[],
  roleOf: Map<string, string>
): RoleFilterCluster[] {
  const groups = new Map<
    string,
    {
      role: string
      collection: string
      signature: string
      conditions: LoggedCondition[]
      days: Map<string, Set<string>>
      sorts: Map<string, number>
    }
  >()
  for (const u of uses) {
    const role = roleOf.get(u.user.toUpperCase())
    if (!role) continue
    const signature = conditionSignature(u.conditions)
    const key = `${role}|${u.collection}|${signature}`
    let g = groups.get(key)
    if (!g) {
      g = {
        role,
        collection: u.collection,
        signature,
        conditions: u.conditions,
        days: new Map(),
        sorts: new Map()
      }
      groups.set(key, g)
    }
    const userKey = u.user.toUpperCase()
    const days = g.days.get(userKey) ?? new Set<string>()
    days.add(u.day)
    g.days.set(userKey, days)
    if (u.sort) g.sorts.set(u.sort, (g.sorts.get(u.sort) ?? 0) + 1)
  }
  const out: RoleFilterCluster[] = []
  for (const g of groups.values()) {
    const people = g.days.size
    const maxDays = Math.max(0, ...[...g.days.values()].map((d) => d.size))
    if (people < MIN_PEOPLE && maxDays < MIN_DAYS_ONE_PERSON) continue
    const uses = [...g.days.values()].reduce((n, d) => n + d.size, 0)
    const sort = [...g.sorts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    out.push({
      role: g.role,
      collection: g.collection,
      signature: g.signature,
      conditions: g.conditions,
      sort,
      people,
      uses
    })
  }
  return out.sort((a, b) => b.people - a.people || b.uses - a.uses)
}

/** A saved view's filter chips as the conditions the browser would send. */
export function viewConditions(filters: unknown): LoggedCondition[] {
  const out: LoggedCondition[] = []
  for (const f of asArray(filters)) {
    const o = f as { path?: unknown; op?: unknown; value?: unknown; not?: unknown }
    if (!o || !Array.isArray(o.path) || typeof o.op !== 'string' || o.not) continue
    const op = o.op.includes(':') ? o.op.split(':')[0] : o.op
    const value = o.op.includes(':') ? o.op.split(':')[1] : (o.value ?? null)
    out.push({ path: o.path.map(String), op, value })
  }
  return out
}

/** Drop clusters a shared view visible to that role already holds. */
export function dropCovered(
  clusters: RoleFilterCluster[],
  views: Array<{ collection: string; filters: unknown; role: string | null }>
): RoleFilterCluster[] {
  const covered = new Set<string>()
  for (const v of views) {
    const conds = viewConditions(v.filters)
    if (!conds.length) continue
    const sig = conditionSignature(conds)
    covered.add(`${v.role ? v.role.toUpperCase() : '*'}|${v.collection}|${sig}`)
  }
  return clusters.filter(
    (c) =>
      !covered.has(`*|${c.collection}|${c.signature}`) &&
      !covered.has(`${c.role.toUpperCase()}|${c.collection}|${c.signature}`)
  )
}

/** Logged conditions → the browser's filter chips, typed from the schema. */
export function toActiveFilters(
  conditions: LoggedCondition[],
  fieldInfo: Map<string, { label: string; type: string; target: string | null }>
): ActiveFilterLike[] {
  return conditions.map((c, i) => {
    const head = fieldInfo.get(c.path[0])
    const value: string | Array<string | number> = Array.isArray(c.value)
      ? c.value.map((v) => (typeof v === 'number' ? v : String(v)))
      : c.value == null
        ? ''
        : String(c.value)
    return {
      id: `ai-${i}`,
      path: c.path,
      pathLabels: c.path.map((p, j) => (j === 0 && head ? head.label : titleCase(p))),
      fieldType: c.path.length === 1 && head ? head.type : 'string',
      op: c.op,
      value,
      ...(c.path.length === 1 && head?.target ? { relTarget: head.target } : {})
    }
  })
}

/** Plain-words summary of a filter set, for the name fallback and the prompt. */
export function describeConditions(
  conditions: LoggedCondition[],
  fieldInfo: Map<string, { label: string }>,
  withValues = true
): string {
  const OPS: Record<string, string> = {
    _eq: 'is',
    _neq: 'is not',
    _in: 'is one of',
    _nin: 'is not one of',
    _gt: 'after',
    _gte: 'from',
    _lt: 'before',
    _lte: 'up to',
    _contains: 'contains',
    _null: 'is empty',
    _nnull: 'is set'
  }
  return conditions
    .map((c) => {
      const label = fieldInfo.get(c.path[0])?.label ?? titleCase(c.path.join(' '))
      const v = !withValues
        ? ''
        : Array.isArray(c.value)
          ? c.value.join(', ')
          : c.value == null
            ? ''
            : String(c.value)
      return `${label} ${OPS[c.op] ?? c.op}${v ? ` ${v.slice(0, 60)}` : ''}`.trim()
    })
    .join(' and ')
}

// ── Loading ───────────────────────────────────────────────────────────────────

const dayOf = (d: unknown) => {
  const t = d instanceof Date ? d : new Date(String(d))
  return Number.isNaN(t.getTime()) ? '' : t.toISOString().slice(0, 10)
}

export async function loadFilterUses(days: number): Promise<FilterUse[]> {
  if (!(await hasColumn('nivaro_api_logs', 'query'))) return []
  const since = new Date(Date.now() - Math.max(1, Math.min(days, 30)) * 864e5)
  const q = db('nivaro_api_logs')
    .where('method', 'GET')
    .where('path', 'like', '/api/items/%')
    .where('query', 'like', '%conditions=%')
    .where('created_at', '>=', since)
    .whereNotNull('user')
    .orderBy('id', 'desc')
    .limit(LOG_ROW_CAP)
    .select('user', 'path', 'query', 'created_at')
  // Session traffic only — a token or API key is an integration, not a person.
  if (await hasColumn('nivaro_api_logs', 'auth'))
    q.where((w) => w.where('auth', 'session').orWhereNull('auth'))
  const rows = (await q) as Array<{
    user: string
    path: string
    query: string
    created_at: unknown
  }>
  const out: FilterUse[] = []
  for (const r of rows) {
    const parsed = parseItemsRequest(r.path, r.query)
    if (!parsed) continue
    out.push({ user: String(r.user), ...parsed, day: dayOf(r.created_at) })
  }
  return out
}

export interface RoleViewContext {
  clusters: RoleFilterCluster[]
  roles: Map<string, { id: string; name: string; members: number }>
  collections: Map<
    string,
    {
      label: string
      fields: Map<string, { label: string; type: string; target: string | null }>
    }
  >
}

export async function loadRoleViewContext(days: number): Promise<RoleViewContext> {
  const uses = await loadFilterUses(days)
  const userIds = [...new Set(uses.map((u) => u.user))]
  const users = await selectInChunks(
    userIds,
    500,
    (chunk) =>
      db('nivaro_users').whereIn('id', chunk).select('id', 'role') as Promise<
        Array<{ id: string; role: string | null }>
      >
  )
  const roleOf = new Map<string, string>()
  for (const u of users) if (u.role) roleOf.set(String(u.id).toUpperCase(), String(u.role))

  const roleRows = (await db('nivaro_roles').select('id', 'name', 'admin_access')) as Array<{
    id: string
    name: string
    admin_access: unknown
  }>
  // Admins see everything and build their own views — suggestions are for
  // the roles people work in.
  const adminRoles = new Set(
    roleRows
      .filter((r) => r.admin_access === true || r.admin_access === 1)
      .map((r) => r.id.toUpperCase())
  )
  for (const [u, r] of roleOf) if (adminRoles.has(r.toUpperCase())) roleOf.delete(u)

  let clusters = clusterRoleFilters(uses, roleOf)
  if (clusters.length) {
    const views = (await db('nivaro_saved_views')
      .whereIn('collection', [...new Set(clusters.map((c) => c.collection))])
      .where('is_shared', true)
      .select('collection', 'filters', 'role', 'default_for_role')) as Array<{
      collection: string
      filters: string | null
      role: string | null
      default_for_role?: string | null
    }>
    clusters = dropCovered(
      clusters,
      views.map((v) => ({
        collection: v.collection,
        filters: safeJson(v.filters),
        role: v.role ?? v.default_for_role ?? null
      }))
    )
  }
  clusters = clusters.slice(0, MAX_SUGGESTIONS)

  const memberCounts = new Map<string, number>()
  const roleIds = [...new Set(clusters.map((c) => c.role))]
  if (roleIds.length) {
    const counts = (await db('nivaro_users')
      .whereIn('role', roleIds)
      .where((w) => w.where('status', 'active').orWhereNull('status'))
      .groupBy('role')
      .select('role')
      .count({ n: '*' })) as Array<{ role: string; n: number | string }>
    for (const c of counts) memberCounts.set(String(c.role).toUpperCase(), Number(c.n))
  }
  const roles = new Map<string, { id: string; name: string; members: number }>()
  for (const r of roleRows)
    if (roleIds.some((id) => id.toUpperCase() === r.id.toUpperCase()))
      roles.set(r.id.toUpperCase(), {
        id: r.id,
        name: r.name,
        members: memberCounts.get(r.id.toUpperCase()) ?? 0
      })

  const colNames = [...new Set(clusters.map((c) => c.collection))]
  const collections: RoleViewContext['collections'] = new Map()
  if (colNames.length) {
    const [cols, fields, rels] = await Promise.all([
      db('nivaro_collections')
        .whereIn('collection', colNames)
        .select('collection', 'display_name') as Promise<
        Array<{ collection: string; display_name: string | null }>
      >,
      db('nivaro_fields')
        .whereIn('collection', colNames)
        .select('collection', 'field', 'label', 'type', 'hidden') as Promise<
        Array<{
          collection: string
          field: string
          label: string | null
          type: string | null
          hidden: unknown
        }>
      >,
      db('nivaro_relations')
        .whereIn('many_collection', colNames)
        .whereNotNull('one_collection')
        .select('many_collection', 'many_field', 'one_collection') as Promise<
        Array<{ many_collection: string; many_field: string; one_collection: string }>
      >
    ])
    for (const c of colNames) {
      const label = cols.find((x) => x.collection === c)?.display_name || titleCase(c)
      collections.set(c, { label, fields: new Map() })
    }
    for (const f of fields) {
      if (f.hidden === true || f.hidden === 1) continue
      const target =
        rels.find((r) => r.many_collection === f.collection && r.many_field === f.field)
          ?.one_collection ?? null
      collections.get(f.collection)?.fields.set(f.field, {
        label: cleanText(f.label, 80) ?? titleCase(f.field),
        type: String(f.type ?? 'string'),
        target
      })
    }
  }
  return { clusters, roles, collections }
}

function safeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

// ── Suggestions (+ optional naming by the model) ──────────────────────────────

export function suggestionId(c: RoleFilterCluster): string {
  return `${c.role}:${c.collection}:${c.signature}`.toLowerCase()
}

export function buildSuggestions(ctx: RoleViewContext): RoleViewSuggestion[] {
  const out: RoleViewSuggestion[] = []
  for (const c of ctx.clusters) {
    const role = ctx.roles.get(c.role.toUpperCase())
    const col = ctx.collections.get(c.collection)
    if (!role || !col) continue
    if (c.people < MIN_PEOPLE && role.members < MIN_MEMBERS_FOR_ONE_PERSON) continue
    const summary = describeConditions(c.conditions, col.fields)
    out.push({
      id: suggestionId(c),
      role,
      collection: c.collection,
      collection_label: col.label,
      conditions: c.conditions,
      filters: toActiveFilters(c.conditions, col.fields),
      sort: c.sort,
      columns: null,
      name: cleanText(`${col.label}: ${summary}`, 60) ?? col.label,
      description: null,
      people: c.people,
      uses: c.uses
    })
  }
  return out
}

const VIEWS_SYSTEM = `You name saved list views for a business application. Each view is a filter people in a role keep applying by hand.
Answer with ONE JSON object and nothing else:
{"views":[{"id":"<view id>","name":"<short view name, <=40 chars>","description":"<who it is for and what it shows, <=140 chars>","columns":["<field key>"]}]}
Rules: only use view ids and field keys from the input. Filters are given as field and operator only (no values). "columns" lists 4-8 field keys of that collection that matter most for the filter's purpose (the filtered fields first), or is omitted. Names are plain words a person would click ("My open orders"), never field keys.`

export function buildViewsPrompt(suggestions: RoleViewSuggestion[], ctx: RoleViewContext): string {
  return JSON.stringify({
    views: suggestions.map((s) => ({
      id: s.id,
      role: s.role.name,
      collection: s.collection_label,
      // Field names + operators only: the values people typed are logged
      // request data and never leave the instance.
      filter: describeConditions(
        s.conditions,
        ctx.collections.get(s.collection)?.fields ?? new Map(),
        false
      ),
      sort: s.sort,
      fields: [...(ctx.collections.get(s.collection)?.fields.keys() ?? [])].slice(0, 60)
    }))
  })
}

export function applyViewsAnswer(
  text: string,
  suggestions: RoleViewSuggestion[],
  ctx: RoleViewContext
): RoleViewSuggestion[] {
  const parsed = parseJsonLoose(text) ?? {}
  const byId = new Map<string, Record<string, unknown>>()
  for (const v of asArray(parsed.views)) {
    const o = v as Record<string, unknown>
    if (o && typeof o.id === 'string') byId.set(o.id, o)
  }
  return suggestions.map((s) => {
    const a = byId.get(s.id)
    if (!a) return s
    const known = ctx.collections.get(s.collection)?.fields ?? new Map()
    const columns = asArray(a.columns)
      .filter((c): c is string => typeof c === 'string' && known.has(c))
      .filter((c, i, arr) => arr.indexOf(c) === i)
      .slice(0, 8)
    return {
      ...s,
      name: cleanText(a.name, 60) ?? s.name,
      description: cleanText(a.description, 200),
      columns: columns.length >= 2 ? columns : s.columns
    }
  })
}

export async function suggestRoleViews(
  days: number,
  complete: AiComplete | null
): Promise<{ suggestions: RoleViewSuggestion[]; ai_used: boolean; ai_error: string | null }> {
  const ctx = await loadRoleViewContext(days)
  const suggestions = buildSuggestions(ctx)
  if (!complete || suggestions.length === 0) return { suggestions, ai_used: false, ai_error: null }
  try {
    const text = await complete({
      system: VIEWS_SYSTEM,
      user: buildViewsPrompt(suggestions, ctx),
      maxTokens: 2500
    })
    return { suggestions: applyViewsAnswer(text, suggestions, ctx), ai_used: true, ai_error: null }
  } catch (err) {
    return {
      suggestions,
      ai_used: false,
      ai_error: (err instanceof Error ? err.message : String(err)).slice(0, 300)
    }
  }
}
