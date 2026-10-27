/**
 * The custom-query widget's SQL path (#2445 follow-up): param binding, the
 * access gate, User Scopes, the cache key, literal substitution and the raw
 * tedious batch — ONE definition shared by POST /widgets-internal/:id/render
 * and the cache warm, so a warmed entry is byte-for-byte what a viewer's own
 * miss would have written under the same key.
 *
 * The key is `customQueryCacheKey(slug, params)` where params are the bound
 * params AFTER scope injection — it carries every value the statement is
 * built from, and nothing else (the SQL is a pure function of sql_text and
 * those params). Widget keys differ from the execute route's for the same
 * question: the route expands every declared param, this path only the bound
 * ones (see routes/widgets-internal.ts).
 */
import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'
import { customQueryCacheKey } from './custom-query-cache.js'
import { applyScopeParams } from './custom-query-scope.js'
import { substituteParams } from './custom-query-substitute.js'

export interface WidgetParamBinding {
  param: string
  input_key: string
  default_value?: string
}

export interface WidgetQueryDef {
  id: number | string
  slug: string
  access: string
  sql_text: string
  cache_ttl?: number | null
  scope_params?: string | null
}

const VALID_ACCESS = new Set(['admin', 'authenticated', 'public'])

/** The single-flight key a widget miss runs under (read-gate.ts adds the tenant). */
export function widgetFlightKey(cacheKey: string): string {
  return `widget|${cacheKey}`
}

/**
 * The query's own access gate, as the person rendering: an unknown access
 * value refuses everyone, `admin` needs an administrator, `authenticated` a
 * signed-in person. Null when allowed.
 */
export function widgetQueryAccessError(
  cq: Pick<WidgetQueryDef, 'access'>,
  signedIn: boolean,
  isAdmin: boolean
): (Error & { statusCode: number }) | null {
  const err = (msg: string, statusCode: number) => Object.assign(new Error(msg), { statusCode })
  if (!VALID_ACCESS.has(cq.access)) return err('Forbidden', 403)
  if (cq.access === 'admin' && !isAdmin) return err('Forbidden', 403)
  if (cq.access === 'authenticated' && !signedIn) return err('Unauthorized', 401)
  return null
}

/**
 * Bound params from the widget's bindings: the input's value, else the
 * binding's default. `unresolved` = some bound param has neither — the
 * render answers "awaiting" and never runs (running would be unscoped).
 */
export function bindWidgetParams(
  bindings: WidgetParamBinding[],
  inputs: Record<string, unknown>
): { params: Record<string, unknown>; unresolved: boolean; awaiting: string[] } {
  const params: Record<string, unknown> = {}
  let unresolved = false
  const awaiting: string[] = []
  for (const b of bindings) {
    const v = inputs[b.input_key]
    const paramKey =
      typeof b.param === 'string' && b.param.startsWith(':') ? b.param.slice(1) : String(b.param)
    const resolved =
      v != null && v !== ''
        ? v
        : b.default_value != null && b.default_value !== ''
          ? b.default_value
          : null
    if (resolved == null) {
      unresolved = true
      if (b.input_key && !awaiting.includes(b.input_key)) awaiting.push(b.input_key)
    }
    params[paramKey] = resolved
  }
  return { params, unresolved, awaiting }
}

/**
 * Full literal substitution (execSqlBatch, not sp_executesql, which swallows
 * stored-procedure result sets). Values never leave their literal (custom-query-substitute.ts).
 */
export function resolveWidgetSql(sqlText: string, params: Record<string, unknown>): string {
  // Literal-aware (M23): the same substitution custom queries use.
  return substituteParams(sqlText, params)
}

export interface WidgetQueryPlan {
  /** Bound params after this person's scope injection. */
  params: Record<string, unknown>
  cacheKey: string
  cacheTtl: number
  resolvedSql: string
}

/**
 * Scope + key + statement for ONE person. Bound params are copied, never
 * mutated. User Scopes on raw SQL apply BEFORE the SQL text and the key are
 * built, so the statement that runs and the key it is cached under both
 * carry this person's scope values.
 */
export async function planWidgetQuery(
  cq: WidgetQueryDef,
  bound: Record<string, unknown>,
  userId: string | null | undefined,
  isAdmin: boolean
): Promise<WidgetQueryPlan> {
  const params = { ...bound }
  await applyScopeParams(cq.scope_params ?? null, params, userId, isAdmin)
  return {
    params,
    cacheKey: customQueryCacheKey(cq.slug, params),
    cacheTtl: Number(cq.cache_ttl ?? 0),
    resolvedSql: resolveWidgetSql(cq.sql_text, params)
  }
}

/** Heavy report procs outlive the 15 s connection requestTimeout. */
export const WIDGET_QUERY_TIMEOUT_MS = 120_000

/**
 * Run a resolved statement as a raw tedious batch. The pool connection is
 * acquired only here (a cache hit must never hold one) and released in finally.
 */
export async function runWidgetSql(
  resolvedSql: string,
  timeoutMs = WIDGET_QUERY_TIMEOUT_MS
): Promise<unknown[]> {
  const knexClient = (db as any).client
  const Driver = knexClient._driver() as {
    Request: new (sql: string, cb: (err: Error | null, count: number) => void) => unknown
  }
  const conn = (await knexClient.acquireConnection()) as { execSqlBatch(r: unknown): void }
  try {
    return await new Promise<unknown[]>((resolve, reject) => {
      let settled = false
      const done = (fn: () => void) => {
        if (!settled) {
          settled = true
          fn()
        }
      }
      const req = new Driver.Request(resolvedSql, (err: Error | null) => {
        if (err) done(() => reject(err))
      }) as {
        on(
          ev: 'row',
          h: (cols: Array<{ metadata: { colName: string }; value: unknown }>) => void
        ): unknown
        on(ev: 'error', h: (e: Error) => void): unknown
        once(ev: 'requestCompleted', h: () => void): unknown
        setTimeout?: (ms: number) => void
      }
      req.setTimeout?.(timeoutMs)
      const collected: unknown[] = []
      req.on('row', (cols) => {
        const row: Record<string, unknown> = {}
        for (const col of cols) row[col.metadata.colName] = col.value
        collected.push(row)
      })
      req.once('requestCompleted', () => done(() => resolve(collected)))
      req.on('error', (e) => done(() => reject(e)))
      conn.execSqlBatch(req)
    })
  } finally {
    await knexClient.releaseConnection(conn)
  }
}

// ── recorded param sets (what the warm replays) ──────────────────────────────

const RECORD_EVERY_MS = 10 * 60_000
const recorded = new Map<string, number>()

/**
 * Remember a cached widget's bound params (BEFORE scope injection — the
 * viewer's own ask, never their allowance) as a `widget` param set, at most
 * once per widget + set per process every 10 minutes: the warm replays the
 * most-seen sets, so seen_count only needs to rank. Fire-and-forget.
 */
export function noteWidgetParamSet(widgetId: number | string, bound: Record<string, unknown>) {
  // Per tenant: one tenant's note must not hold back another's.
  const key = `${getTenantId() ?? ''}|${widgetId}|${JSON.stringify(bound)}`
  const now = Date.now()
  if (now - (recorded.get(key) ?? 0) < RECORD_EVERY_MS) return
  if (recorded.size > 5000) recorded.clear()
  recorded.set(key, now)
  void import('./db-tuning/param-sets.js')
    .then(({ effectiveParams, recordParamSet }) =>
      recordParamSet('widget', String(widgetId), effectiveParams(bound))
    )
    .catch(() => {})
}
