/**
 * Raw-SQL scope coverage (#770).
 *
 * User Scopes are enforced by the items service; raw SQL never passes through
 * it. A custom query is scope-safe only when its `scope_params` carry every
 * dimension that reaches the tables it reads, and an extension route that
 * reads raw SQL is safe only when it applies scopes itself. This report finds
 * the gaps:
 *
 *   - every enabled custom query: the tables it reads (its SQL plus one level
 *     into EXEC'd procedures — the query-freshness inference), the active
 *     dimensions that reach any of those tables, the ones its scope_params do
 *     not cover, and the pages / reports / widgets that run it;
 *   - every authenticated extension GET route that has not declared
 *     `config: { scope: 'enforced' | 'not-scoped' }`.
 *
 * A gap on a query nothing runs is information; a gap on a query a page or
 * widget runs is a leak the readiness check `raw-sql-scope-coverage` warns
 * about. Read-only; 5-minute cache.
 */
import { db } from '../db/index.js'
import { customQueryDependentsIndex, type Dependent } from './custom-query-dependents.js'
import { tablesReadBy } from './query-freshness.js'
import { listScopeDimensions, scopeHopsFor } from './user-scopes.js'

export interface QueryCoverage {
  id: number
  slug: string
  name: string
  tables: string[]
  /** Active dimensions that reach one of the tables, with the tables they reach. */
  reaching: Array<{ dimension: string; label: string; tables: string[] }>
  covered: string[]
  missing: Array<{ dimension: string; label: string }>
  used_by: Dependent[]
  status: 'covered' | 'unscoped-tables' | 'gap' | 'leak'
}

export interface RouteCoverage {
  extension: string
  method: string
  url: string
  gate: string
  scope: 'enforced' | 'not-scoped' | null
}

export interface ScopeCoverageReport {
  dimensions: Array<{ name: string; label: string }>
  queries: QueryCoverage[]
  routes: RouteCoverage[]
  totals: { queries: number; leaks: number; gaps: number; routes_undeclared: number }
  computed_at: string
}

function parseScopeParams(raw: unknown): string[] {
  if (!raw) return []
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!v || typeof v !== 'object') return []
    return Object.values(v as Record<string, { dimension?: string }>)
      .map((d) => String(d?.dimension ?? ''))
      .filter(Boolean)
  } catch {
    return []
  }
}

let cache: { at: number; value: Promise<ScopeCoverageReport> } | null = null
const TTL = 5 * 60_000

export function bustScopeCoverage(): void {
  cache = null
}

export function scopeCoverage(fresh = false): Promise<ScopeCoverageReport> {
  if (!fresh && cache && Date.now() - cache.at < TTL) return cache.value
  const value = compute()
  cache = { at: Date.now(), value }
  value.catch(() => {
    if (cache?.value === value) cache = null
  })
  return value
}

async function compute(): Promise<ScopeCoverageReport> {
  const dims = await listScopeDimensions(true)
  const collections = new Set(
    ((await db('nivaro_collections').pluck('collection')) as string[]).map((c) => c.toLowerCase())
  )
  // (dimension, table) → reaches? One resolve per pair, shared by every query.
  const reach = new Map<string, boolean>()
  const reaches = async (dimName: string, table: string): Promise<boolean> => {
    const key = `${dimName}|${table}`
    const hit = reach.get(key)
    if (hit !== undefined) return hit
    const dim = dims.find((d) => d.name === dimName)
    let ok = false
    if (dim && collections.has(table)) {
      try {
        ok = (await scopeHopsFor(dim, table)) !== null
      } catch {
        ok = false
      }
    }
    reach.set(key, ok)
    return ok
  }

  const rows = (await db('nivaro_custom_queries')
    .where('enabled', true)
    .select('id', 'slug', 'name', 'sql_text', 'scope_params')) as Array<{
    id: number
    slug: string
    name: string
    sql_text: string | null
    scope_params: string | null
  }>

  const dependentsOf = await customQueryDependentsIndex()
  const queries: QueryCoverage[] = []
  for (const q of rows) {
    // Registered collections only: the inference also catches STRING_SPLIT,
    // table variables and prose after FROM, none of which can be scoped.
    const tables = (await tablesReadBy(q.sql_text ?? '')).filter((t) => collections.has(t))
    const reaching: QueryCoverage['reaching'] = []
    for (const d of dims) {
      const hit: string[] = []
      for (const t of tables) if (await reaches(d.name, t)) hit.push(t)
      if (hit.length) reaching.push({ dimension: d.name, label: d.label ?? d.name, tables: hit })
    }
    const covered = parseScopeParams(q.scope_params)
    const missing = reaching
      .filter((r) => !covered.includes(r.dimension))
      .map((r) => ({ dimension: r.dimension, label: r.label }))
    const used_by = missing.length ? dependentsOf(q.id, q.slug) : []
    const status: QueryCoverage['status'] =
      reaching.length === 0
        ? 'unscoped-tables'
        : missing.length === 0
          ? 'covered'
          : used_by.length
            ? 'leak'
            : 'gap'
    queries.push({
      id: q.id,
      slug: q.slug,
      name: q.name,
      tables,
      reaching,
      covered,
      missing,
      used_by,
      status
    })
  }
  const order = { leak: 0, gap: 1, covered: 2, 'unscoped-tables': 3 }
  queries.sort((a, b) => order[a.status] - order[b.status] || a.slug.localeCompare(b.slug))

  // Extension routes: authenticated / custom-gated GETs are the read models.
  const routes: RouteCoverage[] = []
  try {
    const { extensionRoutes } = await import('../extensions/loader.js')
    for (const [extension, list] of extensionRoutes)
      for (const r of list)
        if (r.method === 'GET' && (r.gate === 'authenticated' || r.gate === 'custom'))
          routes.push({
            extension,
            method: r.method,
            url: r.url,
            gate: r.gate,
            scope: r.scope ?? null
          })
  } catch {
    // loader unavailable in this process (scripts)
  }
  routes.sort((a, b) => Number(!!a.scope) - Number(!!b.scope) || a.url.localeCompare(b.url))

  return {
    dimensions: dims.map((d) => ({ name: d.name, label: d.label ?? d.name })),
    queries,
    routes,
    totals: {
      queries: queries.length,
      leaks: queries.filter((q) => q.status === 'leak').length,
      gaps: queries.filter((q) => q.status === 'gap').length,
      routes_undeclared: routes.filter((r) => !r.scope).length
    },
    computed_at: new Date().toISOString()
  }
}
