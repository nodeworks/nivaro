/**
 * Warm caches after boot and before business hours (#2445).
 *
 * Staging's database is rebuilt nightly, so the first dashboard of the day
 * meets a cold SQL Server buffer pool and plan cache and an empty Redis `cq:`
 * cache: nine calls waited more than 10 s on 2026-10-17 that ran in 3–8 s
 * once warm. Two kinds of run:
 *
 *   - usage-ranked (boot, 06:30 weekdays): the most-used slugs of the last 7
 *     days (execute calls and custom-query widget renders in nivaro_api_logs,
 *     development instances excluded; the recorded param sets when the log
 *     read fails), capped, ONLY those with cache_ttl > 0 — a query nobody
 *     caches is never re-run because it was popular — plus every query flagged
 *     warm_daily. Per slug the default parameter set and its top recorded
 *     param sets. A key cached within the last hour is left alone.
 *   - warm_daily (06:00, `only: 'warm_daily'`): every flagged query, any
 *     access value, ALWAYS overwritten, no overall budget. A warm_daily query
 *     with cache_ttl 0 still runs — the flag is the operator asking for it —
 *     which warms the buffer pool and plan cache; its rows are dropped.
 *
 * Every run goes through the execute route's own SQL path
 * (buildFinalParams → execCustomQuerySql) AS AN UNRESTRICTED CALLER: scope
 * injection is a no-op for an administrator, so the key written is exactly the
 * one the route builds for every unrestricted viewer (customQueryCacheKey).
 * Every reader checks the query's access BEFORE it reads the cache, so a key
 * filled for an admin-only query is only ever served to an administrator.
 * Restricted allowances and widget-render keys are NOT filled here (their keys
 * carry scope values / bound params only): the viewer phase
 * (cache-warm-viewers.ts) fills them AS the people who use them, one person per
 * scope signature, after this phase and inside the same budget. Extension
 * warmers (ctx.cache.registerWarm, cache-warmers.ts) run last, same budget.
 * Both run on usage-ranked runs only, and never in cloud mode (cq: keys carry
 * no tenant prefix there, and a boot run has no tenant context).
 *
 * The owner-load report (viewer-independent, uncached, a pure read) is run
 * once when it was used. Queue worklists: the queue phase
 * (cache-warm-queues.ts) replays the most-used FIRST pages as one viewer per
 * (queue, access signature) through fetchQueueItems with `readOnly: true` —
 * the one write on that path (the materialization promotion) is skipped, and
 * nothing it computes is stored or served (there is no queue result cache;
 * it warms the buffer pool, plan cache and the read path's own caches). Same
 * rules as the viewer phase: usage-ranked runs only, never in cloud mode.
 */

import type { Redis } from 'ioredis'
import { cacheSetting } from './cache-config.js'
import {
  type QueuePhaseDeps,
  type QueueUsageLogRow,
  type QueueWarmSummary,
  queueUsageFromLog,
  runQueueTargets,
  selectQueueTargets
} from './cache-warm-queues.js'
import {
  CACHE_WARM_MAX_VIEWERS,
  pickViewerTargets,
  runViewerTargets,
  scopeSignature,
  type ViewerPlan,
  type ViewerQueryDef,
  type ViewerTarget,
  type ViewerUsageRow,
  type ViewerWarmSummary,
  type WarmViewer,
  type WarmWidgetDef
} from './cache-warm-viewers.js'
import { runCacheWarmers, type WarmerOutcome } from './cache-warmers.js'
import { cronTicksEnabled } from './cron-ticks.js'
import {
  customQueryCachedAt,
  customQueryCacheKey,
  customQueryCacheValue
} from './custom-query-cache.js'

/** The overall budget; CACHE_WARM_BUDGET_MS overrides. */
export const CACHE_WARM_DEFAULT_BUDGET_MS = 240_000
export const CACHE_WARM_TOP_SLUGS = 25
export const CACHE_WARM_PARAM_SETS = 3
/** One query's request timeout — passed to tedious, so a timed-out warm really ends. */
export const CACHE_WARM_QUERY_TIMEOUT_MS = 90_000
export const CACHE_WARM_DAILY_TIMEOUT_MS = 120_000
/** A usage-ranked run leaves a key cached more recently than this alone. */
export const CACHE_WARM_FRESH_MS = 60 * 60 * 1000
/** Never more than this many queries in flight. */
const MAX_CONCURRENCY = 2
const USAGE_DAYS = 7
const VALID_ACCESS = new Set(['admin', 'authenticated', 'public'])
/** The value secret-mask.ts stores for a sensitive param — never replayable. */
const MASKED = '••••••'

export type CacheWarmMode = 'on' | 'off' | 'auto'

/** CACHE_WARM=on|off (env wins), else this instance's cache config (Database → Caches,
 *  services/cache-config.ts); auto follows cronTicksEnabled(). An env value that names no
 *  mode reads as unset. */
export function cacheWarmMode(): CacheWarmMode {
  return cacheSetting('warm.mode')
}

export function cacheWarmAllowed(): boolean {
  const mode = cacheWarmMode()
  if (mode === 'off') return false
  if (mode === 'on') return true
  return cronTicksEnabled()
}

/** CACHE_WARM_BUDGET_MS (env wins), else the cache config, else CACHE_WARM_DEFAULT_BUDGET_MS. */
export function cacheWarmBudgetMs(): number {
  return cacheSetting('warm.budget_ms')
}

export interface WarmQueryDef {
  id: number | string
  slug: string
  enabled: boolean | number
  access: string
  params: string | null
  sql_text: string
  cache_ttl: number | null
  warm_daily?: boolean | number | null
  scope_params?: string | null
}

export interface WarmParamSetRow {
  target: string
  params: string
  seen_count: number
  last_seen?: Date | string | null
}

export interface WarmTarget {
  slug: string
  incoming: Record<string, unknown>
  kind: 'default' | 'param-set'
}

/** Usage counts, keyed by slug. */
export type SlugHits = Map<string, number>

function parseJson<T>(raw: unknown): T | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** Fallback usage from the recorded param sets: seen_count of sets used in the window. */
export function hitsFromParamSets(rows: WarmParamSetRow[], since: Date): SlugHits {
  const out: SlugHits = new Map()
  for (const r of rows) {
    const seen = r.last_seen ? new Date(r.last_seen) : null
    if (seen && seen < since) continue
    out.set(r.target, (out.get(r.target) ?? 0) + (Number(r.seen_count) || 0))
  }
  return out
}

/**
 * What to run, in order: every chosen slug's default set first (warm_daily
 * ones, then by use), then the recorded param sets in the same order — so a
 * budget that runs out has warmed the widest set of first screens.
 */
export function pickWarmTargets(input: {
  queries: WarmQueryDef[]
  hits: SlugHits
  paramSets: WarmParamSetRow[]
  only?: 'warm_daily'
  cap?: number
  perSlug?: number
}): WarmTarget[] {
  const cap = input.cap ?? CACHE_WARM_TOP_SLUGS
  const perSlug = input.perSlug ?? CACHE_WARM_PARAM_SETS
  const enabled = input.queries.filter((q) => !!q.enabled)
  // The flag is explicit: any access value (every reader gates access before the cache).
  const daily = enabled.filter((q) => !!q.warm_daily).map((q) => q.slug)
  // Popularity alone never re-runs an uncached query.
  const used =
    input.only === 'warm_daily'
      ? []
      : enabled
          .filter(
            (q) =>
              VALID_ACCESS.has(String(q.access)) &&
              (Number(q.cache_ttl) || 0) > 0 &&
              (input.hits.get(q.slug) ?? 0) > 0
          )
          .sort(
            (a, b) =>
              (input.hits.get(b.slug) ?? 0) - (input.hits.get(a.slug) ?? 0) ||
              a.slug.localeCompare(b.slug)
          )
          .slice(0, cap)
          .map((q) => q.slug)
  const slugs = [...new Set([...daily, ...used])]

  const targets: WarmTarget[] = slugs.map((slug) => ({ slug, incoming: {}, kind: 'default' }))
  for (const slug of slugs) {
    const sets = input.paramSets
      .filter((r) => r.target === slug)
      .sort((a, b) => (Number(b.seen_count) || 0) - (Number(a.seen_count) || 0))
    let taken = 0
    for (const r of sets) {
      if (taken >= perSlug) break
      const params = parseJson<Record<string, unknown>>(r.params)
      if (!params || typeof params !== 'object' || Array.isArray(params)) continue
      // The default set is already first; a masked value is not the real one.
      if (Object.keys(params).length === 0) continue
      if (Object.values(params).some((v) => v === MASKED)) continue
      targets.push({ slug, incoming: params, kind: 'param-set' })
      taken++
    }
  }
  return targets
}

export interface CacheWarmSummary {
  warmed: number
  skipped: number
  failed: number
  /** cq: keys written. */
  cached: number
  ms: number
  budgetSpent: boolean
  targets: number
  /** Widget renders + scoped execute calls, warmed as their viewers. */
  viewers?: ViewerWarmSummary
  /** Queue worklist first pages, read as one viewer per (queue, access signature). */
  queues?: QueueWarmSummary
  /** Extension warmers (ctx.cache.registerWarm). */
  warmers?: WarmerOutcome[]
}

export interface CacheWarmDeps {
  loadQueries: () => Promise<WarmQueryDef[]>
  /** Slug use over the window; null when the request log could not be read. */
  loadHits: (
    since: Date,
    queries: WarmQueryDef[]
  ) => Promise<{ hits: SlugHits; ownerLoad: number } | null>
  loadParamSets: () => Promise<WarmParamSetRow[]>
  buildFinalParams: (defs: never, incoming: Record<string, unknown>) => Record<string, unknown>
  exec: (
    sql: string,
    finalParams: Record<string, unknown>,
    opts: { timeoutMs: number }
  ) => Promise<unknown[]>
  ownerLoad: () => Promise<unknown>
  now: () => number
}

/** The viewer phase's reads and runs (cache-warm-viewers.ts). */
export interface ViewerPhaseDeps {
  /** Per-person use of widget renders and execute calls; null when the log could not be read. */
  loadUsage: (since: Date) => Promise<ViewerUsageRow[] | null>
  loadWidgets: (ids: string[]) => Promise<WarmWidgetDef[]>
  /** Active accounts only, with admin flag + scope signature. */
  loadViewers: (ids: string[]) => Promise<WarmViewer[]>
  loadWidgetParamSets: () => Promise<WarmParamSetRow[]>
  plan: (t: ViewerTarget, query: ViewerQueryDef) => Promise<ViewerPlan>
  gate: <T>(flightKey: string, fn: () => Promise<T>) => Promise<{ value: T; shared: boolean }>
}

export interface CacheWarmOptions {
  redis?: {
    get(key: string): Promise<string | null>
    setex(key: string, seconds: number, value: string): Promise<unknown>
  } | null
  budgetMs?: number
  concurrency?: number
  only?: 'warm_daily'
  log?: (summary: CacheWarmSummary, line: string) => void
  deps?: Partial<CacheWarmDeps>
  /** false = skip the viewer phase. */
  viewers?: Partial<ViewerPhaseDeps> | false
  /** false = skip the queue phase. */
  queues?: Partial<QueuePhaseDeps> | false
  /** false = skip extension warmers; or a gate around each one (tests). */
  warmers?: false | { gate?: <T>(fn: () => Promise<T>) => Promise<T> }
  /** Defaults to CLOUD_META_DB_URL being set. */
  cloud?: boolean
}

function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg
  }
}

interface ApiLogUsageRow {
  path: string
  user: string | null
  n: number | string
}

/**
 * Seven days of the request log for the warm's three surfaces, by path AND
 * person — ONE range scan per run, shared by the slug ranking and the viewer
 * phase (memoized for 5 minutes). Development instances excluded.
 */
const usageMemo = new Map<string, { at: number; p: Promise<ApiLogUsageRow[] | null> }>()
function apiLogUsage(since: Date): Promise<ApiLogUsageRow[] | null> {
  const k = since.toISOString().slice(0, 15)
  const hit = usageMemo.get(k)
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.p
  const p = (async () => {
    try {
      const { db } = await import('../db/index.js')
      const { runLongSql } = await import('./run-long.js')
      const { instanceScope } = await import('./api-log-instances.js')
      // Laptops and probes share the database: their rows are not usage.
      const scope = await instanceScope({})
      // A big range scan in the morning — its own timeout, never the 15 s default.
      const qb = db('nivaro_api_logs')
        // A plain ISO literal: knex inlines a Date in local time, the log is UTC.
        .where('created_at', '>=', since.toISOString().slice(0, 19))
        .where((w) =>
          w
            .where('path', 'like', '/api/custom-queries/%/execute')
            .orWhere('path', 'like', '/api/widgets-internal/%/render')
            .orWhere('path', '/api/reports/owner-load')
        )
      const sql = scope
        .apply(qb)
        .groupBy('path', 'user')
        .select('path', 'user')
        .count({ n: '*' })
        .toQuery()
      return await runLongSql<ApiLogUsageRow>(sql, { timeoutMs: 60_000 })
    } catch {
      return null
    }
  })()
  usageMemo.clear()
  usageMemo.set(k, { at: Date.now(), p })
  return p
}

/** Per-person usage rows from the request log (anonymous rows dropped). */
export function viewerUsageFromLog(rows: ApiLogUsageRow[]): ViewerUsageRow[] {
  const out: ViewerUsageRow[] = []
  for (const r of rows) {
    if (!r.user) continue
    const n = Number(r.n) || 0
    const cq = /^\/api\/custom-queries\/([^/]+)\/execute$/.exec(r.path)
    if (cq) {
      out.push({ kind: 'query', target: decodeSegment(cq[1]), user: String(r.user), n })
      continue
    }
    const w = /^\/api\/widgets-internal\/(\d+)\/render$/.exec(r.path)
    if (w) out.push({ kind: 'widget', target: w[1], user: String(r.user), n })
  }
  return out
}

const defaultViewerDeps: ViewerPhaseDeps = {
  async loadUsage(since) {
    const rows = await apiLogUsage(since)
    return rows ? viewerUsageFromLog(rows) : null
  },
  async loadWidgets(ids) {
    if (!ids.length) return []
    try {
      const { db } = await import('../db/index.js')
      return (await db('nivaro_widgets')
        .whereIn('id', ids.slice(0, 500).map(Number))
        .select('id', 'widget_type', 'config', 'is_active')) as WarmWidgetDef[]
    } catch {
      return []
    }
  },
  async loadViewers(ids) {
    if (!ids.length) return []
    try {
      const { db } = await import('../db/index.js')
      const { selectInChunks } = await import('./db-batch.js')
      const users = await selectInChunks(
        ids,
        500,
        (chunk) =>
          db('nivaro_users')
            .whereIn('id', chunk)
            .where({ status: 'active' })
            .select('id', 'role') as Promise<Array<{ id: string; role: string | null }>>
      )
      const roleIds = [...new Set(users.map((u) => u.role).filter((r): r is string => !!r))]
      const roles = roleIds.length
        ? ((await db('nivaro_roles').whereIn('id', roleIds).select('id', 'admin_access')) as Array<{
            id: string
            admin_access: boolean | number | null
          }>)
        : []
      const adminRole = new Set(
        roles.filter((r) => !!r.admin_access).map((r) => String(r.id).toLowerCase())
      )
      const scopeRows = await selectInChunks(
        users.map((u) => u.id),
        500,
        (chunk) =>
          db('nivaro_user_scopes')
            .whereIn('user', chunk)
            .select('user', 'dimension', 'mode', 'values') as Promise<
            Array<{ user: string; dimension: string; mode: string; values: string | null }>
          >
      )
      const byUser = new Map<
        string,
        Array<{ dimension: string; mode: string; values: unknown[] }>
      >()
      for (const r of scopeRows) {
        const k = String(r.user).toLowerCase()
        const list = byUser.get(k) ?? []
        list.push({
          dimension: String(r.dimension),
          mode: String(r.mode),
          values: parseJson<unknown[]>(r.values) ?? []
        })
        byUser.set(k, list)
      }
      return users.map((u) => {
        const isAdmin = !!u.role && adminRole.has(String(u.role).toLowerCase())
        return {
          id: String(u.id),
          isAdmin,
          signature: scopeSignature(isAdmin, byUser.get(String(u.id).toLowerCase()) ?? []),
          role: u.role ?? null
        }
      })
    } catch {
      return []
    }
  },
  async loadWidgetParamSets() {
    try {
      const { db } = await import('../db/index.js')
      return (await db('nivaro_tuning_param_sets')
        .where({ target_kind: 'widget' })
        .select('target', 'params', 'seen_count', 'last_seen')) as WarmParamSetRow[]
    } catch {
      return []
    }
  },
  async plan(t, query) {
    if (t.surface === 'widget') {
      const { planWidgetQuery, runWidgetSql, widgetFlightKey } = await import('./widget-query.js')
      const p = await planWidgetQuery(query, t.params, t.as.id, t.as.isAdmin)
      return {
        cacheKey: p.cacheKey,
        flightKey: widgetFlightKey(p.cacheKey),
        ttl: p.cacheTtl,
        run: (timeoutMs) => runWidgetSql(p.resolvedSql, timeoutMs)
      }
    }
    const { buildFinalParams, execCustomQuerySql } = await import('./custom-query-exec.js')
    const { applyScopeParams } = await import('./custom-query-scope.js')
    const finalParams = buildFinalParams(
      (parseJson<unknown[]>(query.params) ?? []) as never,
      t.params
    )
    await applyScopeParams(query.scope_params ?? null, finalParams, t.as.id, t.as.isAdmin)
    const key = customQueryCacheKey(query.slug, finalParams)
    return {
      cacheKey: key,
      // The execute route's single-flight key is the cache key itself.
      flightKey: key,
      ttl: Number(query.cache_ttl) || 0,
      run: (timeoutMs) => execCustomQuerySql(query.sql_text, finalParams, { timeoutMs })
    }
  },
  async gate(flightKey, fn) {
    const { sharedGatedRead } = await import('./read-gate.js')
    return sharedGatedRead(flightKey, 'cache-warm', fn, { label: 'cache-warm' })
  }
}

/**
 * Seven days of first-page queue reads (GET /api/queues/:id/items) by path,
 * query string and person — its own scan (the query column is not part of
 * the shared one), memoized for 5 minutes. Development instances excluded.
 */
const queueUsageMemo = new Map<string, { at: number; p: Promise<QueueUsageLogRow[] | null> }>()
function queueApiLogUsage(since: Date): Promise<QueueUsageLogRow[] | null> {
  const k = since.toISOString().slice(0, 15)
  const hit = queueUsageMemo.get(k)
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.p
  const p = (async () => {
    try {
      const { db } = await import('../db/index.js')
      const { runLongSql } = await import('./run-long.js')
      const { instanceScope } = await import('./api-log-instances.js')
      const scope = await instanceScope({})
      const qb = db('nivaro_api_logs')
        .where('created_at', '>=', since.toISOString().slice(0, 19))
        .where('path', 'like', '/api/queues/%/items')
        .where('method', 'GET')
        .where('status', '<', 400)
      const sql = scope
        .apply(qb)
        .groupBy('path', 'query', 'user')
        .select('path', 'query', 'user')
        .count({ n: '*' })
        .toQuery()
      return await runLongSql<QueueUsageLogRow>(sql, { timeoutMs: 60_000 })
    } catch {
      return null
    }
  })()
  queueUsageMemo.clear()
  queueUsageMemo.set(k, { at: Date.now(), p })
  return p
}

/** The route's own parser over a logged query string. */
async function queueQueryParser() {
  const { parseQueueItemsQuery } = await import('./queues.js')
  return (q: Record<string, string>) => {
    const r = parseQueueItemsQuery(q)
    return r.ok ? r.value : null
  }
}

const defaultQueueDeps: QueuePhaseDeps = {
  async loadUsage(since) {
    const rows = await queueApiLogUsage(since)
    return rows ? queueUsageFromLog(rows) : null
  },
  loadViewers: (ids) => defaultViewerDeps.loadViewers(ids),
  async run(t, signal) {
    const { db } = await import('../db/index.js')
    const { canUserReadQueue } = await import('./queue-access.js')
    const { fetchQueueItems } = await import('./queues.js')
    // The person as the request would hold them: their nivaro_users row.
    const user = await db('nivaro_users').where({ id: t.as.id, status: 'active' }).first()
    if (!user) return 'skipped'
    const queue = await db('nivaro_queues').where({ id: t.queueId }).first()
    // The route's gates: 404, then canReadQueue (the only queue visibility gate).
    if (!queue || !canUserReadQueue(queue, user, t.as.isAdmin)) return 'skipped'
    const p = t.parsed
    await fetchQueueItems(t.queueId, user, p.scope, {
      sort: p.sort,
      filters: p.filters,
      withUnseen: true,
      group: p.group,
      ...(p.page !== undefined ? { page: p.page, limit: p.limit } : {}),
      // Never write (skips the materialization promotion); every source read
      // holds its own heavy-read slot, counted against the warm.
      readOnly: true,
      readGate: { signal, who: 'cache-warm' }
    })
    return 'ok'
  }
}

/** What the viewer phase would run. Never throws: an unreadable source means nothing to warm. */
async function selectViewerTargets(
  vdeps: ViewerPhaseDeps,
  queries: WarmQueryDef[],
  paramSets: WarmParamSetRow[],
  now: number
): Promise<ViewerTarget[]> {
  const usage = await vdeps.loadUsage(new Date(now - USAGE_DAYS * 86_400_000)).catch(() => null)
  if (!usage?.length) return []
  // Most-used people first, capped.
  const perUser = new Map<string, number>()
  for (const u of usage) perUser.set(u.user, (perUser.get(u.user) ?? 0) + u.n)
  const userIds = [...perUser]
    .sort((a, b) => b[1] - a[1])
    .slice(0, CACHE_WARM_MAX_VIEWERS)
    .map(([id]) => id)
  const widgetIds = [...new Set(usage.filter((u) => u.kind === 'widget').map((u) => u.target))]
  const [viewers, widgets, widgetParamSets] = await Promise.all([
    vdeps.loadViewers(userIds).catch(() => [] as WarmViewer[]),
    vdeps.loadWidgets(widgetIds).catch(() => [] as WarmWidgetDef[]),
    vdeps.loadWidgetParamSets().catch(() => [] as WarmParamSetRow[])
  ])
  return pickViewerTargets({
    queries: queries as ViewerQueryDef[],
    widgets,
    usage,
    viewers,
    widgetParamSets,
    queryParamSets: paramSets
  })
}

function inCloudMode(opt?: boolean): boolean {
  return opt ?? !!process.env.CLOUD_META_DB_URL
}

const defaultDeps: CacheWarmDeps = {
  async loadQueries() {
    const { db } = await import('../db/index.js')
    return (await db('nivaro_custom_queries')
      .where({ enabled: true })
      .select(
        'id',
        'slug',
        'enabled',
        'access',
        'params',
        'sql_text',
        'cache_ttl',
        'warm_daily',
        'scope_params'
      )) as WarmQueryDef[]
  },
  async loadHits(since, queries) {
    try {
      const { db } = await import('../db/index.js')
      const rows = await apiLogUsage(since)
      if (!rows) return null
      const hits: SlugHits = new Map()
      const widgetHits = new Map<number, number>()
      let ownerLoad = 0
      for (const r of rows) {
        const n = Number(r.n) || 0
        const cq = /^\/api\/custom-queries\/([^/]+)\/execute$/.exec(r.path)
        if (cq) {
          const slug = decodeSegment(cq[1])
          hits.set(slug, (hits.get(slug) ?? 0) + n)
          continue
        }
        const w = /^\/api\/widgets-internal\/(\d+)\/render$/.exec(r.path)
        if (w) widgetHits.set(Number(w[1]), (widgetHits.get(Number(w[1])) ?? 0) + n)
        else if (r.path === '/api/reports/owner-load') ownerLoad += n
      }
      // A custom-query widget render counts toward its query's rank: the same
      // SQL warms what it reads (the viewer phase fills the widget's own key).
      if (widgetHits.size) {
        const widgets = (await db('nivaro_widgets')
          .whereIn('id', [...widgetHits.keys()].slice(0, 500))
          .select('id', 'widget_type', 'config')) as Array<{
          id: number
          widget_type: string
          config: string | null
        }>
        const slugById = new Map(queries.map((q) => [String(q.id), q.slug]))
        for (const wd of widgets) {
          if (wd.widget_type !== 'custom-query') continue
          const qid = parseJson<{ query_id?: unknown }>(wd.config)?.query_id
          const slug = qid != null ? slugById.get(String(qid)) : undefined
          if (slug) hits.set(slug, (hits.get(slug) ?? 0) + (widgetHits.get(Number(wd.id)) ?? 0))
        }
      }
      return { hits, ownerLoad }
    } catch {
      return null
    }
  },
  async loadParamSets() {
    try {
      const { db } = await import('../db/index.js')
      return (await db('nivaro_tuning_param_sets')
        .where({ target_kind: 'query' })
        .select('target', 'params', 'seen_count', 'last_seen')) as WarmParamSetRow[]
    } catch {
      return []
    }
  },
  buildFinalParams: (() => {
    throw new Error('replaced at run time')
  }) as never,
  exec: (() => {
    throw new Error('replaced at run time')
  }) as never,
  async ownerLoad() {
    const { buildOwnerLoadReport } = await import('./owner-load.js')
    return buildOwnerLoadReport({ collection: null })
  },
  now: () => Date.now()
}

async function resolveDeps(partial?: Partial<CacheWarmDeps>): Promise<CacheWarmDeps> {
  const deps = { ...defaultDeps, ...partial }
  if (!partial?.buildFinalParams || !partial?.exec) {
    const m = await import('./custom-query-exec.js')
    if (!partial?.buildFinalParams) deps.buildFinalParams = m.buildFinalParams as never
    if (!partial?.exec) deps.exec = m.execCustomQuerySql
  }
  return deps
}

async function selectTargets(
  deps: CacheWarmDeps,
  only: 'warm_daily' | undefined,
  now: number
): Promise<{
  queries: WarmQueryDef[]
  targets: WarmTarget[]
  ownerLoad: boolean
  paramSets: WarmParamSetRow[]
}> {
  const queries = await deps.loadQueries()
  const since = new Date(now - USAGE_DAYS * 86_400_000)
  const paramSets = await deps.loadParamSets()
  const usage = only ? null : await deps.loadHits(since, queries)
  const targets = pickWarmTargets({
    queries,
    hits: usage?.hits ?? hitsFromParamSets(paramSets, since),
    paramSets,
    only
  })
  return { queries, targets, ownerLoad: !only && (usage?.ownerLoad ?? 0) > 0, paramSets }
}

export interface CacheWarmPlan {
  slugs: Array<{ slug: string; param_sets: number }>
  owner_load: boolean
  /** Viewer phase: per widget / scoped query, the signatures and runs it would compute. */
  viewers?: Array<{
    surface: 'widget' | 'query'
    target: string
    slug: string
    signatures: number
    people: number
    runs: number
  }>
  /** Queue phase: per (queue, access signature), the replayed first page. */
  queues?: Array<{
    queue: string
    signature: string
    people: number
    hits: number
    as: string
    query: string
  }>
  warmers?: string[]
}

/** What a run would warm (the cron's dry run): slugs and how many param sets each. */
export async function planCacheWarm(
  opts: Pick<CacheWarmOptions, 'only' | 'deps' | 'viewers' | 'queues' | 'cloud'> = {}
): Promise<CacheWarmPlan> {
  const deps = { ...defaultDeps, ...opts.deps }
  const now = deps.now()
  const { queries, targets, ownerLoad, paramSets } = await selectTargets(deps, opts.only, now)
  const bySlug = new Map<string, number>()
  for (const t of targets)
    bySlug.set(t.slug, (bySlug.get(t.slug) ?? 0) + (t.kind === 'param-set' ? 1 : 0))
  const plan: CacheWarmPlan = {
    slugs: [...bySlug].map(([slug, param_sets]) => ({ slug, param_sets })),
    owner_load: ownerLoad
  }
  if (opts.only || inCloudMode(opts.cloud)) return plan
  if (opts.viewers !== false) {
    const vdeps = { ...defaultViewerDeps, ...(opts.viewers || {}) }
    const vt = await selectViewerTargets(vdeps, queries, paramSets, now)
    const agg = new Map<
      string,
      {
        surface: 'widget' | 'query'
        target: string
        slug: string
        sigs: Set<string>
        people: number
        runs: number
      }
    >()
    for (const t of vt) {
      const target = t.widgetId ?? t.slug
      const k = `${t.surface}|${target}`
      const a = agg.get(k) ?? {
        surface: t.surface,
        target,
        slug: t.slug,
        sigs: new Set(),
        people: 0,
        runs: 0
      }
      if (!a.sigs.has(t.as.signature)) {
        a.sigs.add(t.as.signature)
        a.people += t.members
      }
      a.runs++
      agg.set(k, a)
    }
    plan.viewers = [...agg.values()].map(({ sigs, ...a }) => ({ ...a, signatures: sigs.size }))
  }
  if (opts.queues !== false) {
    const qdeps = { ...defaultQueueDeps, ...(opts.queues || {}) }
    const qt = await selectQueueTargets(
      qdeps,
      new Date(now - USAGE_DAYS * 86_400_000),
      queueQueryParser
    ).catch(() => [])
    plan.queues = qt.map((t) => ({
      queue: t.queueId,
      signature: t.signature,
      people: t.members,
      hits: t.hits,
      as: t.as.id,
      query: t.query
    }))
  }
  const { listCacheWarmers } = await import('./cache-warmers.js')
  plan.warmers = listCacheWarmers().map((w) => w.id)
  return plan
}

/** Run the warm. Never throws for one query's failure; the summary counts it. */
export async function runCacheWarm(opts: CacheWarmOptions = {}): Promise<CacheWarmSummary> {
  const deps = await resolveDeps(opts.deps)
  const started = deps.now()
  // warm_daily is the operator's explicit list: no overall budget, always overwrite.
  const daily = opts.only === 'warm_daily'
  const deadline = daily
    ? Number.POSITIVE_INFINITY
    : started + (opts.budgetMs ?? cacheWarmBudgetMs())
  const summary: CacheWarmSummary = {
    warmed: 0,
    skipped: 0,
    failed: 0,
    cached: 0,
    ms: 0,
    budgetSpent: false,
    targets: 0
  }

  const { queries, targets, ownerLoad, paramSets } = await selectTargets(deps, opts.only, started)
  const bySlug = new Map(queries.map((q) => [q.slug, q]))
  summary.targets = targets.length

  const seenKeys = new Set<string>()
  let next = 0
  const worker = async () => {
    while (next < targets.length) {
      const t = targets[next++]
      const remaining = deadline - deps.now()
      if (remaining <= 0) {
        summary.budgetSpent = true
        summary.skipped++
        continue
      }
      const q = bySlug.get(t.slug)
      if (!q) {
        summary.skipped++
        continue
      }
      let finalParams: Record<string, unknown>
      try {
        const defs = (parseJson<unknown[]>(q.params) ?? []) as never
        finalParams = deps.buildFinalParams(defs, t.incoming)
      } catch {
        // A required param with no default: the route answers 400 too.
        summary.skipped++
        continue
      }
      const key = customQueryCacheKey(q.slug, finalParams)
      if (seenKeys.has(key)) {
        summary.skipped++
        continue
      }
      seenKeys.add(key)
      const ttl = Number(q.cache_ttl) || 0
      if (!daily && ttl > 0 && opts.redis) {
        // Cached within the hour (a rolling deploy, a second run): the pool is
        // warm too. Older entries are refreshed.
        const at = customQueryCachedAt(await opts.redis.get(key).catch(() => null))
        if (at != null && deps.now() - at < CACHE_WARM_FRESH_MS) {
          summary.skipped++
          continue
        }
      }
      try {
        // The timeout reaches tedious: a warm that runs out really ends and
        // hands its connection back.
        // warm_daily keeps the 120 s every viewer's miss gets — a flagged
        // procedure that needs it must not start failing at 06:00.
        const rows = await deps.exec(q.sql_text, finalParams, {
          timeoutMs: daily
            ? CACHE_WARM_DAILY_TIMEOUT_MS
            : Math.max(1, Math.min(CACHE_WARM_QUERY_TIMEOUT_MS, remaining))
        })
        if (ttl > 0 && opts.redis) {
          await opts.redis.setex(key, ttl, customQueryCacheValue(rows, new Date(deps.now())))
          summary.cached++
        }
        summary.warmed++
      } catch {
        summary.failed++
        if (deps.now() >= deadline) summary.budgetSpent = true
      }
    }
  }
  const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, opts.concurrency ?? MAX_CONCURRENCY))
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker))

  if (ownerLoad) {
    if (deadline - deps.now() <= 0) {
      summary.budgetSpent = true
      summary.skipped++
    } else {
      // Plain knex reads, each on the pool's own statement timeout.
      try {
        await deps.ownerLoad()
        summary.warmed++
      } catch {
        summary.failed++
      }
    }
  }

  // Usage-ranked runs only: the warm_daily list is the operator's, nothing else.
  // Never in cloud mode: a boot/cron run has no tenant context there, and cq:
  // keys carry no tenant prefix — a warmed entry could reach another tenant.
  const cloud = inCloudMode(opts.cloud)
  if (!daily && !cloud && opts.viewers !== false) {
    const vdeps = { ...defaultViewerDeps, ...(opts.viewers || {}) }
    try {
      const vt = await selectViewerTargets(vdeps, queries, paramSets, deps.now())
      summary.viewers = await runViewerTargets(vt, queries as ViewerQueryDef[], {
        deadline,
        deps: { plan: vdeps.plan, gate: vdeps.gate, now: deps.now },
        redis: opts.redis,
        seenKeys,
        concurrency: opts.concurrency,
        freshMs: CACHE_WARM_FRESH_MS,
        queryTimeoutMs: CACHE_WARM_QUERY_TIMEOUT_MS
      })
      if (summary.viewers.budgetSpent) summary.budgetSpent = true
    } catch {
      /* the viewer phase never fails the warm */
    }
  }
  // Queue worklists' first pages, read-only, as one viewer per (queue, access
  // signature) — same rules as the viewer phase (no tenant context at boot).
  if (!daily && !cloud && opts.queues !== false) {
    const qdeps = { ...defaultQueueDeps, ...(opts.queues || {}) }
    try {
      const qt = await selectQueueTargets(
        qdeps,
        new Date(deps.now() - USAGE_DAYS * 86_400_000),
        queueQueryParser
      )
      summary.queues = await runQueueTargets(qt, { deadline, now: deps.now, run: qdeps.run })
      if (summary.queues.budgetSpent) summary.budgetSpent = true
    } catch {
      /* the queue phase never fails the warm */
    }
  }
  if (!daily && !cloud && opts.warmers !== false) {
    const gate =
      opts.warmers?.gate ??
      (async <T>(fn: () => Promise<T>) => {
        const { withReadGate } = await import('./read-gate.js')
        return withReadGate('cache-warm', fn, { label: 'cache-warm:extension' })
      })
    summary.warmers = await runCacheWarmers({ deadline, now: deps.now, gate })
    if (summary.warmers.some((w) => w.status === 'skipped')) summary.budgetSpent = true
  }

  summary.ms = deps.now() - started
  const v = summary.viewers
  const w = summary.warmers ?? []
  const qs = summary.queues
  const extra = [
    v
      ? `; viewers: ${v.warmed} warmed (${v.cached} cached, ${v.joined} joined) for ${v.signatures} scope signature(s), ${v.skipped} skipped, ${v.failed} failed of ${v.targets}`
      : '',
    qs
      ? `; queues: ${qs.warmed} first page(s) read for ${qs.signatures} access signature(s), ${qs.skipped} skipped, ${qs.failed} failed of ${qs.targets}`
      : '',
    w.length
      ? `; extension warmers: ${w.filter((x) => x.status === 'ok').length} ok, ${w.filter((x) => x.status === 'failed').length} failed, ${w.filter((x) => x.status === 'timeout').length} timed out, ${w.filter((x) => x.status === 'skipped').length} skipped`
      : ''
  ].join('')
  opts.log?.(
    summary,
    `cache warm${daily ? ' (warm_daily)' : ''}: ${summary.warmed} warmed (${summary.cached} cached), ${summary.skipped} skipped, ${summary.failed} failed of ${summary.targets}${extra} in ${summary.ms}ms${summary.budgetSpent ? ' — budget spent' : ''}`
  )
  return summary
}

/**
 * The in-process metadata of the most-used collections — every process, cheap.
 * These caches hold 30–60 s, so this only spares the first requests after a boot.
 */
export async function warmMetadata(limit = 15): Promise<number> {
  const { db } = await import('../db/index.js')
  const { runLongSql } = await import('./run-long.js')
  const { listCollections, getFields } = await import('./collections.js')
  await listCollections()
  const sql = db('nivaro_api_logs')
    .where('created_at', '>=', new Date(Date.now() - 86_400_000).toISOString().slice(0, 19))
    .whereNotNull('collection')
    .groupBy('collection')
    .select('collection')
    .count({ n: '*' })
    .orderBy('n', 'desc')
    .limit(limit)
    .toQuery()
  const rows = await runLongSql<{ collection: string }>(sql, { timeoutMs: 30_000 }).catch(() => [])
  for (const r of rows) await getFields(r.collection).catch(() => [])
  // The queue read path's per-process caches (cache-warm-queues.ts).
  const { warmQueueReadCaches } = await import('./cache-warm-queues.js')
  await warmQueueReadCaches().catch(() => 0)
  return rows.length
}

/**
 * Boot warm, once per cluster per running version: N replicas booting together
 * (or a rolling deploy) warm once. The key outlives the warm so a restart of the
 * same build within hours does not warm again; a nightly-rebuild restart later
 * in the day does. Not the cron leader lease — the old process still holds it
 * during a rolling deploy.
 */
export const BOOT_WARM_HOLD_SECONDS = 4 * 3600

export async function takeBootWarm(
  redis: Redis | null | undefined,
  version: string,
  holder: string
): Promise<boolean> {
  if (!redis) return true
  const res = await redis.set(`nvr:warm:${version}`, holder, 'EX', BOOT_WARM_HOLD_SECONDS, 'NX')
  return res === 'OK'
}
