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
 * Restricted allowances are never warmed (their key carries scope values), and
 * widget-render keys are not filled — they key on bound params only; a widget
 * gains only the warm database.
 *
 * The owner-load report (viewer-independent, uncached, a pure read) is run
 * once when it was used. Queue worklists are NOT warmed: fetchQueueItems can
 * promote materialization and record empty-queue explanations (writes).
 */
import type { Redis } from 'ioredis'
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
      const { instanceScope } = await import('./api-log-instances.js')
      // Laptops and probes share the database: their rows are not usage.
      const scope = await instanceScope({})
      // Seven days of the request log is a big range scan in the morning — its
      // own timeout, never the 15 s pool default.
      const qb = db('nivaro_api_logs')
        // A plain ISO literal: knex inlines a Date in local time, the log is UTC.
        .where('created_at', '>=', since.toISOString().slice(0, 19))
        .where((w) =>
          w
            .where('path', 'like', '/api/custom-queries/%/execute')
            .orWhere('path', 'like', '/api/widgets-internal/%/render')
            .orWhere('path', '/api/reports/owner-load')
        )
      const sql = scope.apply(qb).groupBy('path').select('path').count({ n: '*' }).toQuery()
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
      // A custom-query widget render counts toward its query's rank: its key is
      // not filled (bound params only), but the same SQL warms what it reads.
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
  return { queries, targets, ownerLoad: !only && (usage?.ownerLoad ?? 0) > 0 }
}

/** What a run would warm (the cron's dry run): slugs and how many param sets each. */
export async function planCacheWarm(
  opts: Pick<CacheWarmOptions, 'only' | 'deps'> = {}
): Promise<{ slugs: Array<{ slug: string; param_sets: number }>; owner_load: boolean }> {
  const deps = { ...defaultDeps, ...opts.deps }
  const { targets, ownerLoad } = await selectTargets(deps, opts.only, deps.now())
  const bySlug = new Map<string, number>()
  for (const t of targets)
    bySlug.set(t.slug, (bySlug.get(t.slug) ?? 0) + (t.kind === 'param-set' ? 1 : 0))
  return {
    slugs: [...bySlug].map(([slug, param_sets]) => ({ slug, param_sets })),
    owner_load: ownerLoad
  }
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

  const { queries, targets, ownerLoad } = await selectTargets(deps, opts.only, started)
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

  summary.ms = deps.now() - started
  opts.log?.(
    summary,
    `cache warm${daily ? ' (warm_daily)' : ''}: ${summary.warmed} warmed (${summary.cached} cached), ${summary.skipped} skipped, ${summary.failed} failed of ${summary.targets} in ${summary.ms}ms${summary.budgetSpent ? ' — budget spent' : ''}`
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
