// api/src/services/traffic-taps/inspector-detail.ts
/**
 * Inspector detail taps (entityDetail only — nothing is counted on the hot path):
 *  - #1107 hook-cost: per-hook run times (hooks.timings) for an items/system collection,
 *    slowest first, with the owner (extension id or the core file that registered it).
 *  - #1115 client-experience: RUM p75s (nivaro_rum_events) for a page builder page beside the
 *    API figures the map already shows.
 *  - #1121 slow-tail: the slow requests the trace ring kept for the entity, with their
 *    heaviest statements, so the inspector can explain one.
 */
import { db } from '../../db/index.js'
import { hooks } from '../../hooks/registry.js'
import { listTraces, type TraceRecord, unaccountedMs } from '../request-trace.js'
import type { TrafficLane } from '../traffic-entities.js'
import { historyNarrowing, traceBelongsTo } from '../traffic-history.js'
import { matchExtensionRoute } from '../traffic-map.js'
import { registerTrafficTap } from '../traffic-taps.js'

export const HOOK_COST_TAP = 'hook-cost'
export const CLIENT_EXPERIENCE_TAP = 'client-experience'
export const SLOW_TAIL_TAP = 'slow-tail'

function split(entityKey: string): { lane: TrafficLane; entity: string } | null {
  const cut = entityKey.indexOf('/')
  if (cut <= 0) return null
  return { lane: entityKey.slice(0, cut) as TrafficLane, entity: entityKey.slice(cut + 1) }
}

// ── #1107 hook cost ──────────────────────────────────────────────────────────
export interface HookCostRow {
  timing: string
  action: string
  collection: string
  owner: string
  name: string | null
  runs: number
  errors: number
  p50_ms: number | null
  p95_ms: number | null
  max_ms: number | null
}

/** The hooks that have run for `collection` (its own + `*` hooks), slowest p95 first. */
export function hookCostFor(collection: string, all = hooks.timings()): HookCostRow[] {
  return all
    .filter((h) => h.runs > 0 && (h.collection === collection || h.collection === '*'))
    .sort((a, b) => (b.p95_ms ?? -1) - (a.p95_ms ?? -1) || b.runs - a.runs)
    .slice(0, 25)
    .map((h) => ({
      timing: h.timing,
      action: h.action,
      collection: h.collection,
      owner: h.owner,
      name: h.name,
      runs: h.runs,
      errors: h.errors,
      p50_ms: h.p50_ms,
      p95_ms: h.p95_ms,
      max_ms: h.max_ms
    }))
}

registerTrafficTap({
  id: HOOK_COST_TAP,
  entityDetail(entityKey) {
    const k = split(entityKey)
    if (!k || (k.lane !== 'items' && k.lane !== 'system') || k.entity.startsWith('__')) return
    return { hooks: hookCostFor(k.entity) }
  }
})

// ── #1115 client experience ──────────────────────────────────────────────────
export interface ClientExperience {
  /** How far back the RUM samples reach (hours). */
  hours: number
  rows: Array<{
    app: string
    route: string
    samples: number
    lcp_p75: number | null
    load_p75: number | null
    route_p75: number | null
  }>
}

const p75 = (vals: number[]): number | null => {
  if (vals.length === 0) return null
  const s = [...vals].sort((a, z) => a - z)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.75))]
}

/** RUM routes that belong to a page slug: `/p/<slug>` (and any app's `/<…>/<slug>`). */
export function rumRoutesFor(slug: string): string[] {
  return [`%/p/${slug}`, `%/pages/${slug}`]
}

/** Per app × route p75s from raw RUM rows (pure). */
export function summarizeRum(
  rows: Array<{
    route: string
    kind: string
    lcp_ms: number | null
    duration_ms: number | null
    app: string | null
  }>
): ClientExperience['rows'] {
  const by = new Map<
    string,
    { app: string; route: string; l: number[]; ld: number[]; r: number[] }
  >()
  for (const row of rows) {
    if (row.kind === 'rage') continue
    const app = row.app ?? 'admin'
    const key = `${app} ${row.route}`
    const b = by.get(key) ?? { app, route: row.route, l: [], ld: [], r: [] }
    if (row.kind === 'load') {
      if (row.lcp_ms != null) b.l.push(row.lcp_ms)
      if (row.duration_ms != null) b.ld.push(row.duration_ms)
    } else if (row.duration_ms != null) b.r.push(row.duration_ms)
    by.set(key, b)
  }
  return [...by.values()]
    .map((b) => ({
      app: b.app,
      route: b.route,
      samples: b.ld.length + b.r.length,
      lcp_p75: p75(b.l),
      load_p75: p75(b.ld),
      route_p75: p75(b.r)
    }))
    .sort((a, z) => z.samples - a.samples)
}

const RUM_HOURS = 24
registerTrafficTap({
  id: CLIENT_EXPERIENCE_TAP,
  async entityDetail(entityKey) {
    const k = split(entityKey)
    if (k?.lane !== 'pages' || k.entity.startsWith('__')) return
    const slug = k.entity.replace(/[\\%_[]/g, (c) => `\\${c}`)
    const rows = (await Promise.resolve(
      db('nivaro_rum_events')
        .where('created_at', '>=', new Date(Date.now() - RUM_HOURS * 3600_000))
        .whereIn('kind', ['load', 'route'])
        .where((b) => {
          for (const like of rumRoutesFor(slug)) b.orWhereRaw("route LIKE ? ESCAPE '\\'", [like])
        })
        .orderBy('created_at', 'desc')
        .limit(5000)
        .select('route', 'kind', 'lcp_ms', 'duration_ms', 'app')
    ).catch(() => [])) as Parameters<typeof summarizeRum>[0]
    return { hours: RUM_HOURS, rows: summarizeRum(rows) } satisfies ClientExperience
  }
})

// ── #1121 slow tail ──────────────────────────────────────────────────────────
export interface SlowTraceWire {
  id: string
  method: string
  route: string
  url: string
  status: number
  user: string | null
  total_ms: number
  ts: string
  spans: TraceRecord['spans']
  queries: number
  sql_ms: number
  top_sql: TraceRecord['top_sql']
  wide: TraceRecord['wide']
  unaccounted_ms: number
  slowest_phase: string | null
}

/** The slow traces this process kept that classify to the entity, slowest first (≤ 10). */
export function slowTracesFor(
  lane: TrafficLane,
  entity: string,
  traces: TraceRecord[] = listTraces(200)
): SlowTraceWire[] {
  const n = historyNarrowing(lane, entity)
  return traces
    .filter((t) => traceBelongsTo(t, lane, entity, n.routePrefix, matchExtensionRoute))
    .sort((a, b) => b.total_ms - a.total_ms)
    .slice(0, 10)
    .map((t) => ({
      id: t.id,
      method: t.method,
      route: t.route,
      url: t.url,
      status: t.status,
      user: t.user,
      total_ms: t.total_ms,
      ts: t.ts,
      spans: t.spans,
      queries: t.queries,
      sql_ms: t.sql_ms,
      top_sql: t.top_sql,
      wide: t.wide,
      unaccounted_ms: unaccountedMs(t),
      slowest_phase:
        t.spans.length > 0 ? t.spans.reduce((a, b) => (b.ms > a.ms ? b : a)).phase : null
    }))
}

registerTrafficTap({
  id: SLOW_TAIL_TAP,
  entityDetail(entityKey) {
    const k = split(entityKey)
    if (!k || k.entity.startsWith('__')) return
    return { traces: slowTracesFor(k.lane, k.entity) }
  }
})
