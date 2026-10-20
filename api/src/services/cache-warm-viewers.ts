/**
 * Cache warm, viewer phase (#2445 follow-up): the cache entries the
 * unrestricted warm cannot fill.
 *
 *   - custom-query WIDGET renders (POST /widgets-internal/:id/render): their
 *     key is the widget's bound params after the viewer's User Scopes, so it
 *     differs from the execute route's key for the same query;
 *   - custom-query EXECUTE calls by people whose User Scopes narrow the query
 *     (scope_params declared + a restrict-mode allowance): their key carries
 *     their scope values.
 *
 * WHO. The people who actually used that widget / query in the last 7 days
 * (nivaro_api_logs path + user, development instances excluded), active
 * accounts only, grouped by SCOPE SIGNATURE: administrator, or the sorted
 * set of their restrict-mode allowances (dimension = values). The cache key
 * is per scope VALUES, never per user — 200 people with the same allowance
 * read one entry, so one person per signature is computed.
 *
 * AS WHOM — the correctness argument. Every entry is computed for ONE real
 * person (the signature group's most frequent viewer), through the same
 * functions the viewer's own request runs: the query's access gate with that
 * person's admin flag, applyScopeParams with that person's id, then the key
 * and the statement from the scoped params. The statement is a pure function
 * of (sql_text, scoped params) and the key encodes exactly those params, so
 * any reader of that key — who passed their own access gate first, as every
 * reader does — gets exactly the rows their own miss would produce. The
 * signature only decides how many people are computed; were two people
 * mis-grouped, the second simply computes a different key and misses. A key
 * is never filled from one person's scope and read under another's.
 *
 * WHAT. Only cached queries (cache_ttl > 0) — a ttl-0 procedure may write and
 * is never re-run because it was popular; enabled queries with a valid access
 * value; active custom-query widgets. Per widget: the bound default set (when
 * every binding has a default) and its most-seen recorded bound sets
 * (`widget` param sets, written by the render route); per scoped query: the
 * default set and its most-seen recorded sets. Defaults first, by usage, so a
 * budget that runs out has warmed the widest set of first screens.
 *
 * HOW. Every run goes through sharedGatedRead under the SAME single-flight
 * key the viewer's request uses — it takes a heavy-read slot, and a viewer
 * missing on that key meanwhile joins the warm's run instead of running it
 * twice (the value has the route's {rows, cachedAt} shape). A key cached
 * within the hour is left alone.
 */

import type { WarmParamSetRow, WarmQueryDef } from './cache-warm.js'
import { customQueryCachedAt, customQueryCacheValue } from './custom-query-cache.js'
import {
  bindWidgetParams,
  type WidgetParamBinding,
  type WidgetQueryDef,
  widgetQueryAccessError
} from './widget-query.js'

export const CACHE_WARM_TOP_WIDGETS = 25
export const CACHE_WARM_TOP_SCOPED = 25
/** Scope signatures computed per widget / query. */
export const CACHE_WARM_SIGNATURES = 20
export const CACHE_WARM_VIEWER_PARAM_SETS = 3
/** Distinct people read per run. */
export const CACHE_WARM_MAX_VIEWERS = 1000
const MASKED = '••••••'

export interface ViewerUsageRow {
  kind: 'widget' | 'query'
  /** Widget id or query slug. */
  target: string
  user: string
  n: number
}

export interface WarmViewer {
  id: string
  isAdmin: boolean
  /** 'admin', '' (no restriction), or the sorted restrict allowances. */
  signature: string
  /** nivaro_users.role — the queue phase groups by it (policies + row filters). */
  role?: string | null
}

export interface WarmWidgetDef {
  id: number | string
  widget_type: string
  config: string | null
  is_active?: boolean | number | null
}

export type ViewerQueryDef = WarmQueryDef & { scope_params?: string | null }

export interface ViewerTarget {
  surface: 'widget' | 'query'
  slug: string
  widgetId?: string
  /** Widget: bound params (pre-scope). Query: incoming params (pre-defaults, pre-scope). */
  params: Record<string, unknown>
  kind: 'default' | 'param-set'
  as: WarmViewer
  /** Uses of this target by the signature group — the order. */
  groupHits: number
  /** People in the group. */
  members: number
  seen: number
}

function parseJson<T>(raw: unknown): T | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** Scope signature from a person's admin flag and their nivaro_user_scopes rows. */
export function scopeSignature(
  isAdmin: boolean,
  rows: Array<{ dimension: string; mode: string; values: unknown[] }>
): string {
  if (isAdmin) return 'admin'
  return rows
    .filter((r) => r.mode === 'restrict' && Array.isArray(r.values) && r.values.length > 0)
    .map((r) => `${r.dimension}=${JSON.stringify(r.values.map(String).sort())}`)
    .sort()
    .join('|')
}

function declaresScope(raw: string | null | undefined): boolean {
  const d = parseJson<Record<string, { dimension?: unknown }>>(raw ?? null)
  return (
    !!d &&
    typeof d === 'object' &&
    Object.values(d).some((v) => v && typeof v.dimension === 'string')
  )
}

const VALID_ACCESS = new Set(['admin', 'authenticated', 'public'])

function warmableQuery(q: ViewerQueryDef | undefined): q is ViewerQueryDef {
  return !!q && !!q.enabled && VALID_ACCESS.has(String(q.access)) && (Number(q.cache_ttl) || 0) > 0
}

interface Group {
  signature: string
  as: WarmViewer
  hits: number
  members: number
}

/** Usage rows of one target grouped by signature, most-used first; admins only when required. */
function groupsFor(
  rows: ViewerUsageRow[],
  viewers: Map<string, WarmViewer>,
  opts: { adminOnly: boolean; restrictedOnly: boolean; cap: number }
): Group[] {
  const bySig = new Map<string, { hits: number; members: Map<string, number> }>()
  for (const r of rows) {
    const v = viewers.get(r.user.toLowerCase())
    if (!v) continue
    if (opts.adminOnly && !v.isAdmin) continue
    if (opts.restrictedOnly && (v.signature === 'admin' || v.signature === '')) continue
    const g = bySig.get(v.signature) ?? { hits: 0, members: new Map() }
    g.hits += r.n
    g.members.set(v.id, (g.members.get(v.id) ?? 0) + r.n)
    bySig.set(v.signature, g)
  }
  const out: Group[] = []
  for (const [signature, g] of bySig) {
    // The group's most frequent viewer (ties: lowest id, deterministic).
    const [repId] = [...g.members].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
    out.push({
      signature,
      as: viewers.get(repId.toLowerCase()) as WarmViewer,
      hits: g.hits,
      members: g.members.size
    })
  }
  return out
    .sort((a, b) => b.hits - a.hits || a.signature.localeCompare(b.signature))
    .slice(0, opts.cap)
}

function topSets(rows: WarmParamSetRow[], target: string, cap: number) {
  return rows
    .filter((r) => r.target === target)
    .sort((a, b) => (Number(b.seen_count) || 0) - (Number(a.seen_count) || 0))
    .map((r) => ({
      params: parseJson<Record<string, unknown>>(r.params),
      seen: Number(r.seen_count) || 0
    }))
    .filter(
      (s): s is { params: Record<string, unknown>; seen: number } =>
        !!s.params &&
        typeof s.params === 'object' &&
        !Array.isArray(s.params) &&
        !Object.values(s.params).some((v) => v === MASKED)
    )
    .slice(0, cap)
}

/**
 * What the viewer phase runs, in order. Pure: everything it reads is passed in.
 */
export function pickViewerTargets(input: {
  queries: ViewerQueryDef[]
  widgets: WarmWidgetDef[]
  usage: ViewerUsageRow[]
  viewers: WarmViewer[]
  widgetParamSets: WarmParamSetRow[]
  queryParamSets: WarmParamSetRow[]
  topWidgets?: number
  topScoped?: number
  signatures?: number
  perTarget?: number
}): ViewerTarget[] {
  const sigCap = input.signatures ?? CACHE_WARM_SIGNATURES
  const perTarget = input.perTarget ?? CACHE_WARM_VIEWER_PARAM_SETS
  const viewers = new Map(input.viewers.map((v) => [v.id.toLowerCase(), v]))
  const queryById = new Map(input.queries.map((q) => [String(q.id), q]))
  const queryBySlug = new Map(input.queries.map((q) => [q.slug, q]))
  const usageOf = (kind: 'widget' | 'query', target: string) =>
    input.usage.filter((u) => u.kind === kind && u.target === target)
  const hitsOf = (rows: ViewerUsageRow[]) => rows.reduce((n, r) => n + r.n, 0)

  const defaults: ViewerTarget[] = []
  const sets: ViewerTarget[] = []

  // ── widgets ──
  const widgets = input.widgets
    .filter((w) => w.widget_type === 'custom-query' && (w.is_active == null || !!w.is_active))
    .map((w) => {
      const cfg = parseJson<{ query_id?: unknown; param_bindings?: WidgetParamBinding[] }>(w.config)
      const q = cfg?.query_id != null ? queryById.get(String(cfg.query_id)) : undefined
      const rows = usageOf('widget', String(w.id))
      return { w, q, bindings: cfg?.param_bindings ?? [], rows, hits: hitsOf(rows) }
    })
    .filter((x) => warmableQuery(x.q) && x.hits > 0)
    .sort((a, b) => b.hits - a.hits || String(a.w.id).localeCompare(String(b.w.id)))
    .slice(0, input.topWidgets ?? CACHE_WARM_TOP_WIDGETS)

  for (const { w, q, bindings, rows } of widgets) {
    const query = q as ViewerQueryDef
    const groups = groupsFor(rows, viewers, {
      adminOnly: query.access === 'admin',
      restrictedOnly: false,
      cap: sigCap
    })
    const def = bindWidgetParams(bindings, {})
    // Recorded sets re-bound in binding order: the key is JSON of the params,
    // and the route builds them in binding order.
    const recorded = topSets(input.widgetParamSets, String(w.id), perTarget)
      .map((s) => {
        const bound: Record<string, unknown> = {}
        for (const b of bindings) {
          const k =
            typeof b.param === 'string' && b.param.startsWith(':')
              ? b.param.slice(1)
              : String(b.param)
          const v = s.params[k]
          if (v == null || v === '') return null
          bound[k] = v
        }
        return { bound, seen: s.seen }
      })
      .filter((s): s is { bound: Record<string, unknown>; seen: number } => !!s)
    for (const g of groups) {
      const base = {
        surface: 'widget' as const,
        slug: query.slug,
        widgetId: String(w.id),
        as: g.as,
        groupHits: g.hits,
        members: g.members
      }
      if (!def.unresolved) defaults.push({ ...base, params: def.params, kind: 'default', seen: 0 })
      for (const s of recorded)
        sets.push({ ...base, params: s.bound, kind: 'param-set', seen: s.seen })
    }
  }

  // ── execute calls by people whose User Scopes narrow the query ──
  const slugs = [...new Set(input.usage.filter((u) => u.kind === 'query').map((u) => u.target))]
    .map((slug) => ({ q: queryBySlug.get(slug), rows: usageOf('query', slug) }))
    .filter((x) => warmableQuery(x.q) && declaresScope(x.q?.scope_params))
    .map((x) => ({ ...x, hits: hitsOf(x.rows) }))
    .sort((a, b) => b.hits - a.hits || String(a.q?.slug).localeCompare(String(b.q?.slug)))
    .slice(0, input.topScoped ?? CACHE_WARM_TOP_SCOPED)
  for (const { q, rows } of slugs) {
    const query = q as ViewerQueryDef
    // Unrestricted people share the key the unrestricted warm already filled;
    // an admin-only query has no restricted reader (scope is a no-op for admins).
    if (query.access === 'admin') continue
    const groups = groupsFor(rows, viewers, { adminOnly: false, restrictedOnly: true, cap: sigCap })
    const recorded = topSets(input.queryParamSets, query.slug, perTarget).filter(
      (s) => Object.keys(s.params).length > 0
    )
    for (const g of groups) {
      const base = {
        surface: 'query' as const,
        slug: query.slug,
        as: g.as,
        groupHits: g.hits,
        members: g.members
      }
      defaults.push({ ...base, params: {}, kind: 'default', seen: 0 })
      for (const s of recorded)
        sets.push({ ...base, params: s.params, kind: 'param-set', seen: s.seen })
    }
  }

  const byUse = (a: ViewerTarget, b: ViewerTarget) => b.groupHits - a.groupHits || b.seen - a.seen
  return [...defaults.sort(byUse), ...sets.sort(byUse)]
}

// ── the run ─────────────────────────────────────────────────────────────────

export interface ViewerPlan {
  cacheKey: string
  flightKey: string
  ttl: number
  run: (timeoutMs: number) => Promise<unknown[]>
}

export interface ViewerWarmDeps {
  /** Widget: planWidgetQuery + runWidgetSql. Query: buildFinalParams + applyScopeParams + execCustomQuerySql. */
  plan: (t: ViewerTarget, query: ViewerQueryDef) => Promise<ViewerPlan>
  /** sharedGatedRead under the viewer request's own single-flight key. */
  gate: <T>(flightKey: string, fn: () => Promise<T>) => Promise<{ value: T; shared: boolean }>
  now: () => number
}

export interface ViewerWarmSummary {
  warmed: number
  /** Runs a viewer had already started — joined, not repeated. */
  joined: number
  skipped: number
  failed: number
  cached: number
  targets: number
  budgetSpent: boolean
  /** Distinct scope signatures computed. */
  signatures: number
}

export async function runViewerTargets(
  targets: ViewerTarget[],
  queries: ViewerQueryDef[],
  opts: {
    deadline: number
    deps: ViewerWarmDeps
    redis?: {
      get(key: string): Promise<string | null>
      setex(key: string, seconds: number, value: string): Promise<unknown>
    } | null
    seenKeys?: Set<string>
    concurrency?: number
    freshMs: number
    queryTimeoutMs: number
  }
): Promise<ViewerWarmSummary> {
  const { deps } = opts
  const bySlug = new Map(queries.map((q) => [q.slug, q]))
  const seenKeys = opts.seenKeys ?? new Set<string>()
  const sigs = new Set<string>()
  const s: ViewerWarmSummary = {
    warmed: 0,
    joined: 0,
    skipped: 0,
    failed: 0,
    cached: 0,
    targets: targets.length,
    budgetSpent: false,
    signatures: 0
  }
  let next = 0
  const worker = async () => {
    while (next < targets.length) {
      const t = targets[next++]
      const remaining = opts.deadline - deps.now()
      if (remaining <= 0) {
        s.budgetSpent = true
        s.skipped++
        continue
      }
      const q = bySlug.get(t.slug)
      // Writers never run: a ttl-0 query is not cached and may have side effects.
      if (!warmableQuery(q)) {
        s.skipped++
        continue
      }
      // The access gate as THIS person, exactly as their request applies it.
      if (widgetQueryAccessError(q as WidgetQueryDef, true, t.as.isAdmin)) {
        s.skipped++
        continue
      }
      let plan: ViewerPlan
      try {
        plan = await deps.plan(t, q)
      } catch {
        // A required param with no default: the request answers 400 too.
        s.skipped++
        continue
      }
      if (seenKeys.has(plan.cacheKey) || plan.ttl <= 0) {
        s.skipped++
        continue
      }
      seenKeys.add(plan.cacheKey)
      if (opts.redis) {
        const at = customQueryCachedAt(await opts.redis.get(plan.cacheKey).catch(() => null))
        if (at != null && deps.now() - at < opts.freshMs) {
          s.skipped++
          continue
        }
      }
      try {
        const left = Math.max(1, Math.min(opts.queryTimeoutMs, opts.deadline - deps.now()))
        const out = await deps.gate(plan.flightKey, async () => {
          const rows = await plan.run(left)
          const at = new Date(deps.now()).toISOString()
          if (opts.redis) {
            await opts.redis.setex(plan.cacheKey, plan.ttl, customQueryCacheValue(rows, at))
            s.cached++
          }
          return { rows, cachedAt: at }
        })
        if (out.shared) s.joined++
        s.warmed++
        sigs.add(t.as.signature)
      } catch {
        s.failed++
        if (deps.now() >= opts.deadline) s.budgetSpent = true
      }
    }
  }
  const n = Math.max(1, Math.min(2, opts.concurrency ?? 2))
  await Promise.all(Array.from({ length: Math.min(n, targets.length) }, worker))
  s.signatures = sigs.size
  return s
}
