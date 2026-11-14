// api/src/services/slow-screens-logic.ts
/**
 * Slow screens for one person (people page → Activity → Slow screens, and support tickets
 * about slowness). Pure half: no database, no clock. slow-screens.ts reads the rows.
 *
 * Where the numbers come from:
 * - Load time: the person's own browser timings (nivaro_rum_events: a full page load reports
 *   its largest paint, else its load event; a move inside the app reports the time to a
 *   settled frame). Browser, OS and a screen-width class ride each row.
 * - Visits: nivaro_admin_journeys (page, entered_at, how long they stayed). The request log
 *   carries no page, so a call belongs to the visit that was open when it arrived (the same
 *   rule as the Traffic Map's people lenses, traffic-inspect/people-ux-logic.ts).
 * - Calls behind a page: the person's own requests in the first seconds of their visits to it.
 * - A replay: their session recording that was running at the moment of a slow visit.
 */
import { type JourneyRow, percentile, type Visit } from './traffic-inspect/people-ux-logic.js'

/** Pages listed, slowest first. */
export const PAGE_LIMIT = 12
/** Pages whose calls are looked up (each costs a slice of the request-log read). */
export const CALL_PAGES = 8
/** Recent visits per page whose calls are read. */
export const VISITS_PER_PAGE = 15
/** Calls listed per page. */
export const CALLS_PER_PAGE = 6
/** A beacon arrives up to ~10 s after the timing it reports (the browser batches them). */
export const BEACON_LAG_MS = 15_000

export interface TimingRow {
  page: string
  app: string
  kind: 'load' | 'route'
  /** Load: largest paint, else load event. Route: time to a settled frame. */
  ms: number
  ttfb_ms: number | null
  /** When the beacon arrived (epoch ms). */
  at: number
  browser: string | null
  os: string | null
  screen: string | null
}

export interface RequestRow {
  at: number
  method: string
  /** Already folded to a template (`/api/items/orders/:id`). */
  path: string
  status: number
  latency_ms: number
}

export interface RecordingRow {
  id: string
  started_at: number
  /** ended_at, else the last event; null = still open (counted as up to now). */
  ended_at: number | null
}

export interface SlowVisit {
  at: number
  ms: number
  kind: 'load' | 'route'
  browser: string | null
  screen: string | null
  replay: { recording_id: string; offset_ms: number } | null
}

export interface CallStat {
  method: string
  path: string
  /** Calls seen across the visits read. */
  n: number
  /** Visits (of those read) that made it. */
  visits: number
  median_ms: number
  worst_ms: number
  errors: number
}

export interface DeviceStat {
  browser: string | null
  os: string | null
  screen: string | null
  n: number
  median_ms: number
}

export interface PageStat {
  app: string
  page: string
  n: number
  loads: number
  moves: number
  median_ms: number
  p95_ms: number
  worst_ms: number
  /** Visits to this page in the window (journeys), when the journey log has them. */
  visits: number
  devices: DeviceStat[]
  slow_visits: SlowVisit[]
  calls: CallStat[]
  /** Visits whose calls were read (0 = no visits to tie calls to). */
  calls_from_visits: number
}

const pageKey = (app: string, page: string) => `${app} ${page}`

function median(values: number[]): number {
  return Math.round(percentile(values, 0.5) ?? 0)
}

/** Per page: how often, median and p95, worst, the devices it was seen on, its slowest visits. */
export function summarisePages(rows: TimingRow[], limit = PAGE_LIMIT): PageStat[] {
  const by = new Map<string, TimingRow[]>()
  for (const r of rows) {
    if (!Number.isFinite(r.ms) || r.ms < 0) continue
    const k = pageKey(r.app, r.page)
    const l = by.get(k)
    if (l) l.push(r)
    else by.set(k, [r])
  }
  const out: PageStat[] = []
  for (const list of by.values()) {
    const ms = list.map((r) => r.ms)
    const devices = new Map<string, TimingRow[]>()
    for (const r of list) {
      const k = `${r.browser ?? ''}|${r.os ?? ''}|${r.screen ?? ''}`
      const d = devices.get(k)
      if (d) d.push(r)
      else devices.set(k, [r])
    }
    out.push({
      app: list[0].app,
      page: list[0].page,
      n: list.length,
      loads: list.filter((r) => r.kind === 'load').length,
      moves: list.filter((r) => r.kind === 'route').length,
      median_ms: median(ms),
      p95_ms: Math.round(percentile(ms, 0.95) ?? 0),
      worst_ms: Math.max(...ms),
      visits: 0,
      devices: [...devices.values()]
        .map((d) => ({
          browser: d[0].browser,
          os: d[0].os,
          screen: d[0].screen,
          n: d.length,
          median_ms: median(d.map((r) => r.ms))
        }))
        .sort((a, b) => b.n - a.n || b.median_ms - a.median_ms)
        .slice(0, 4),
      slow_visits: [...list]
        .sort((a, b) => b.ms - a.ms || b.at - a.at)
        .slice(0, 3)
        .map((r) => ({
          at: r.at,
          ms: r.ms,
          kind: r.kind,
          browser: r.browser,
          screen: r.screen,
          replay: null
        })),
      calls: [],
      calls_from_visits: 0
    })
  }
  return out
    .sort((a, b) => b.p95_ms - a.p95_ms || b.median_ms - a.median_ms || b.n - a.n)
    .slice(0, limit)
}

/** Overall: which browsers and screen sizes this person uses, most used first. */
export function deviceMix(rows: TimingRow[]): {
  browsers: Array<{ name: string; n: number }>
  screens: Array<{ name: string; n: number }>
} {
  const count = (pick: (r: TimingRow) => string | null) => {
    const m = new Map<string, number>()
    for (const r of rows) {
      const v = pick(r)
      if (v) m.set(v, (m.get(v) ?? 0) + 1)
    }
    return [...m.entries()]
      .map(([name, n]) => ({ name, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 5)
  }
  return {
    browsers: count((r) => [r.browser, r.os].filter(Boolean).join(' · ') || null),
    screens: count((r) => r.screen)
  }
}

/** How long after a visit begins its calls still count as "loading this page". */
export function callWindowMs(p95: number): number {
  return Math.max(5_000, Math.min(30_000, p95 + 1_500))
}

/** The person's visits to one page, newest first. */
export function visitsOf(visits: Visit[], app: string, page: string): Visit[] {
  return visits.filter((v) => v.page === page && v.app === app).sort((a, b) => b.start - a.start)
}

/** Time windows to read requests for (newest visits per page), merged where they overlap. */
export function requestWindows(
  pages: Array<{ visits: Visit[]; windowMs: number }>,
  perPage = VISITS_PER_PAGE
): Array<[number, number]> {
  const raw: Array<[number, number]> = []
  for (const p of pages)
    for (const v of p.visits.slice(0, perPage))
      raw.push([v.start, Math.min(v.end, v.start + p.windowMs)])
  raw.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const w of raw) {
    const last = merged[merged.length - 1]
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1])
    else merged.push([w[0], w[1]])
  }
  return merged
}

/** The calls made in the first `windowMs` of these visits, per route, slowest first. */
export function callsBehind(
  visits: Visit[],
  requests: RequestRow[],
  windowMs: number,
  limit = CALLS_PER_PAGE
): CallStat[] {
  const by = new Map<
    string,
    { method: string; path: string; ms: number[]; v: Set<number>; e: number }
  >()
  visits.forEach((v, i) => {
    const end = Math.min(v.end, v.start + windowMs)
    for (const r of requests) {
      if (r.at < v.start || r.at > end) continue
      if (
        /^\/api\/(rum|traffic-map|presence|socket|health|version|session-recordings|analytics\/pageview)/.test(
          r.path
        )
      )
        continue
      const k = `${r.method} ${r.path}`
      let b = by.get(k)
      if (!b) {
        b = { method: r.method, path: r.path, ms: [], v: new Set(), e: 0 }
        by.set(k, b)
      }
      b.ms.push(r.latency_ms)
      b.v.add(i)
      if (r.status >= 500 || (r.status >= 400 && r.status !== 401 && r.status !== 404)) b.e++
    }
  })
  return [...by.values()]
    .map((b) => ({
      method: b.method,
      path: b.path,
      n: b.ms.length,
      visits: b.v.size,
      median_ms: median(b.ms),
      worst_ms: Math.max(...b.ms),
      errors: b.e
    }))
    .sort((a, b) => b.median_ms - a.median_ms || b.n - a.n)
    .slice(0, limit)
}

/**
 * The visit a timing belongs to: same page, begun between (beacon - its time - lag) and the
 * beacon; the one closest to where the timing says it started.
 */
export function visitForTiming(visits: Visit[], t: TimingRow): Visit | null {
  const expected = t.at - t.ms
  let best: Visit | null = null
  let bestGap = Number.POSITIVE_INFINITY
  for (const v of visits) {
    if (v.page !== t.page || v.app !== t.app) continue
    if (v.start > t.at || v.start < expected - BEACON_LAG_MS) continue
    const gap = Math.abs(v.start - expected)
    if (gap < bestGap) {
      best = v
      bestGap = gap
    }
  }
  return best
}

/** A recording that was running at `at`, with where in it to start (2 s before). */
export function replayAt(
  recordings: RecordingRow[],
  at: number,
  now: number
): { recording_id: string; offset_ms: number } | null {
  let pick: RecordingRow | null = null
  for (const r of recordings) {
    const end = r.ended_at ?? now
    if (r.started_at <= at && at <= end && (!pick || r.started_at > pick.started_at)) pick = r
  }
  return pick
    ? { recording_id: pick.id, offset_ms: Math.max(0, at - pick.started_at - 2_000) }
    : null
}

/** Journey rows → this person's visits (people-ux buildVisits, one person). */
export type { JourneyRow, Visit }
