/**
 * Warm caches after boot and before business hours (#2445).
 *
 * Staging's database is rebuilt nightly, so the first dashboard of the day
 * meets a cold SQL Server buffer pool and plan cache and an empty Redis `cq:`
 * cache: nine calls waited more than 10 s on 2026-10-17 that ran in 3–8 s
 * once warm. This pre-runs the custom queries people actually open:
 *
 *   - the most-used slugs of the last 7 days (execute calls and custom-query
 *     widget renders in nivaro_api_logs; the recorded param sets when the log
 *     read fails), capped, plus every query flagged warm_daily;
 *   - per slug the default parameter set and its top recorded param sets.
 *
 * Every run goes through the execute route's own SQL path
 * (buildFinalParams → execCustomQuerySql) AS AN UNRESTRICTED CALLER: scope
 * injection is a no-op for an administrator, so the key written is exactly the
 * one the route builds for every unrestricted viewer. A query with
 * cache_ttl > 0 gets its result under that key in the route's
 * `{cached_at, rows}` shape; a query with cache_ttl 0 still runs (that warms
 * the buffer pool and plan cache — the real morning cost) and its rows are
 * dropped. Restricted allowances are never warmed: their key carries the
 * person's scope values.
 *
 * The owner-load report (viewer-independent, uncached, a pure read) is run
 * once when it was used. Queue worklists are NOT warmed: fetchQueueItems can
 * promote materialization and record empty-queue explanations (writes).
 */
import type { Redis } from 'ioredis'
import { cronTicksEnabled } from './cron-ticks.js'

/** The overall budget; CACHE_WARM_BUDGET_MS overrides. */
export const CACHE_WARM_DEFAULT_BUDGET_MS = 240_000
export const CACHE_WARM_TOP_SLUGS = 25
export const CACHE_WARM_PARAM_SETS = 3
/** One query may hold its worker this long; the statement itself still ends at tedious's 120 s. */
export const CACHE_WARM_QUERY_TIMEOUT_MS = 90_000
const USAGE_DAYS = 7
const VALID_ACCESS = new Set(['admin', 'authenticated', 'public'])
/** The value secret-mask.ts stores for a sensitive param — never replayable. */
const MASKED = '••••••'

export type CacheWarmMode = 'on' | 'off' | 'auto'

/** CACHE_WARM=on|off; unset (auto) follows cronTicksEnabled(). */
export function cacheWarmMode(): CacheWarmMode {
  const raw = (process.env.CACHE_WARM ?? '').trim().toLowerCase()
  if (['on', 'true', '1', 'yes'].includes(raw)) return 'on'
  if (['off', 'false', '0', 'no'].includes(raw)) return 'off'
  return 'auto'
}

export function cacheWarmAllowed(): boolean {
  const mode = cacheWarmMode()
  if (mode === 'off') return false
  if (mode === 'on') return true
  return cronTicksEnabled()
}

export function cacheWarmBudgetMs(): number {
  const n = Number(process.env.CACHE_WARM_BUDGET_MS)
  return Number.isFinite(n) && n > 0 ? n : CACHE_WARM_DEFAULT_BUDGET_MS
}

/** The custom-query cache key — the same string routes/custom-queries.ts
 *  builds after scope injection. Keep the two in step. */
export function customQueryCacheKey(slug: string, finalParams: Record<string, unknown>): string {
  return `cq:${slug}:${JSON.stringify(finalParams)}`
}

/** The cached value, in the execute route's `{cached_at, rows}` shape. */
export function customQueryCacheValue(rows: unknown[], cachedAt: Date = new Date()): string {
  return JSON.stringify({ cached_at: cachedAt.toISOString(), rows })
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
  const eligible = input.queries.filter((q) => !!q.enabled && VALID_ACCESS.has(String(q.access)))
  const daily = eligible.filter((q) => !!q.warm_daily).map((q) => q.slug)
  const used =
    input.only === 'warm_daily'
      ? []
      : eligible
          .filter((q) => (input.hits.get(q.slug) ?? 0) > 0)
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
  exec: (sql: string, finalParams: Record<string, unknown>) => Promise<unknown[]>
  ownerLoad: () => Promise<unknown>
  now: () => number
}

export interface CacheWarmOptions {
  redis?: {
    exists(key: string): Promise<number>
    setex(key: string, seconds: number, value: string): Promise<unknown>
  } | null
  budgetMs?: number
  concurrency?: number
  only?: 'warm_daily'
  log?: (summary: CacheWarmSummary, line: string) => void
  deps?: Partial<CacheWarmDeps>
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
        'warm_daily'
      )) as WarmQueryDef[]
  },
  async loadHits(since, queries) {
    try {
      const { db } = await import('../db/index.js')
      const { runLongSql } = await import('./run-long.js')
      // Seven days of the request log is a big range scan in the morning — its
      // own timeout, never the 15 s pool default.
      const sql = db('nivaro_api_logs')
        // A plain ISO literal: knex inlines a Date in local time, the log is UTC.
        .where('created_at', '>=', since.toISOString().slice(0, 19))
        .where((w) =>
          w
            .where('path', 'like', '/api/custom-queries/%/execute')
            .orWhere('path', 'like', '/api/widgets-internal/%/render')
            .orWhere('path', '/api/reports/owner-load')
        )
        .groupBy('path')
        .select('path')
        .count({ n: '*' })
        .toQuery()
      const rows = await runLongSql<{ path: string; n: number | string }>(sql, {
        timeoutMs: 60_000
      })
      const hits: SlugHits = new Map()
      const widgetHits = new Map<number, number>()
      let ownerLoad = 0
      for (const r of rows) {
        const n = Number(r.n) || 0
        const cq = /^\/api\/custom-queries\/([^/]+)\/execute$/.exec(r.path)
        if (cq) {
          let slug = cq[1]
          try {
            slug = decodeURIComponent(slug)
          } catch {
            /* keep the raw segment */
          }
          hits.set(slug, (hits.get(slug) ?? 0) + n)
          continue
        }
        const w = /^\/api\/widgets-internal\/(\d+)\/render$/.exec(r.path)
        if (w) widgetHits.set(Number(w[1]), (widgetHits.get(Number(w[1])) ?? 0) + n)
        else if (r.path === '/api/reports/owner-load') ownerLoad += n
      }
      // A custom-query widget render counts toward its query: warming the route's
      // key runs the same SQL, which warms what the widget reads.
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

class WarmTimeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new WarmTimeout('warm timeout')), Math.max(1, ms))
      timer.unref?.()
    })
  ]).finally(() => clearTimeout(timer))
}

/** What a run would warm (the cron's dry run): slugs and how many param sets each. */
export async function planCacheWarm(
  opts: Pick<CacheWarmOptions, 'only' | 'deps'> = {}
): Promise<{ slugs: Array<{ slug: string; param_sets: number }>; owner_load: boolean }> {
  const deps = { ...defaultDeps, ...opts.deps }
  const queries = await deps.loadQueries()
  const since = new Date(deps.now() - USAGE_DAYS * 86_400_000)
  const paramSets = await deps.loadParamSets()
  const usage = opts.only ? null : await deps.loadHits(since, queries)
  const targets = pickWarmTargets({
    queries,
    hits: usage?.hits ?? hitsFromParamSets(paramSets, since),
    paramSets,
    only: opts.only
  })
  const bySlug = new Map<string, number>()
  for (const t of targets)
    bySlug.set(t.slug, (bySlug.get(t.slug) ?? 0) + (t.kind === 'param-set' ? 1 : 0))
  return {
    slugs: [...bySlug].map(([slug, param_sets]) => ({ slug, param_sets })),
    owner_load: !opts.only && (usage?.ownerLoad ?? 0) > 0
  }
}

/** Run the warm. Never throws for one query's failure; the summary counts it. */
export async function runCacheWarm(opts: CacheWarmOptions = {}): Promise<CacheWarmSummary> {
  const deps = await resolveDeps(opts.deps)
  const started = deps.now()
  const budget = opts.budgetMs ?? cacheWarmBudgetMs()
  const deadline = started + budget
  const summary: CacheWarmSummary = {
    warmed: 0,
    skipped: 0,
    failed: 0,
    cached: 0,
    ms: 0,
    budgetSpent: false,
    targets: 0
  }

  const queries = await deps.loadQueries()
  const bySlug = new Map(queries.map((q) => [q.slug, q]))
  const since = new Date(started - USAGE_DAYS * 86_400_000)
  const paramSets = await deps.loadParamSets()
  const usage = opts.only ? null : await deps.loadHits(since, queries)
  const targets = pickWarmTargets({
    queries,
    hits: usage?.hits ?? hitsFromParamSets(paramSets, since),
    paramSets,
    only: opts.only
  })
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
      if (ttl > 0 && opts.redis) {
        // Still cached (a rolling deploy, a second run): the pool is warm too.
        const fresh = await opts.redis.exists(key).catch(() => 0)
        if (fresh) {
          summary.skipped++
          continue
        }
      }
      try {
        const rows = await withTimeout(
          deps.exec(q.sql_text, finalParams),
          Math.min(CACHE_WARM_QUERY_TIMEOUT_MS, remaining)
        )
        if (ttl > 0 && opts.redis) {
          await opts.redis.setex(key, ttl, customQueryCacheValue(rows, new Date(deps.now())))
          summary.cached++
        }
        summary.warmed++
      } catch (err) {
        summary.failed++
        if (err instanceof WarmTimeout && deps.now() >= deadline) summary.budgetSpent = true
      }
    }
  }
  const concurrency = Math.max(1, Math.min(4, opts.concurrency ?? 2))
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker))

  if (!opts.only && (usage?.ownerLoad ?? 0) > 0) {
    const remaining = deadline - deps.now()
    if (remaining <= 0) {
      summary.budgetSpent = true
      summary.skipped++
    } else {
      try {
        await withTimeout(deps.ownerLoad(), Math.min(CACHE_WARM_QUERY_TIMEOUT_MS, remaining))
        summary.warmed++
      } catch {
        summary.failed++
      }
    }
  }

  summary.ms = deps.now() - started
  opts.log?.(
    summary,
    `cache warm: ${summary.warmed} warmed (${summary.cached} cached), ${summary.skipped} skipped, ${summary.failed} failed of ${summary.targets} in ${summary.ms}ms${summary.budgetSpent ? ' — budget spent' : ''}`
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
