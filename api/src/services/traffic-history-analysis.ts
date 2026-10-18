// api/src/services/traffic-history-analysis.ts
/**
 * Traffic Map — pure figures behind the long-history features (no database, no clock reads
 * unless passed in), so each one is unit-tested on its own:
 *
 *  - latency buckets + percentiles from a bucket histogram (the minute store, #2228)
 *  - latencyDistribution  — one route's request durations as a log histogram, with its modes
 *                           (a route split into fast and slow requests, #2193)
 *  - slowParameters       — which query parameters / filter values go with slow requests (#2252)
 *  - jobsAgainstPeaks     — scheduled jobs over the day's traffic curve + a quieter slot (#2165)
 *  - projectWhatIf        — headroom, pool pressure and event-loop lag under a scenario (#2151)
 *  - buildTimelapse       — grouped counts → playback frames (#2183)
 */

// ── latency buckets (shared by the minute store and the hourly log read) ─────
/** Upper bounds (ms) of the latency buckets; one more bucket holds everything above the last. */
export const LAT_BOUNDS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000] as const
export const LAT_BUCKETS = LAT_BOUNDS.length + 1

export function latBucket(ms: number): number {
  for (let i = 0; i < LAT_BOUNDS.length; i++) if (ms < LAT_BOUNDS[i]) return i
  return LAT_BOUNDS.length
}

/**
 * The `q` quantile (0–1) of a bucket histogram, interpolated inside its bucket. `max` caps the
 * open-ended last bucket (and every answer). 0 for an empty histogram.
 */
export function histPercentile(hist: ArrayLike<number>, q: number, max?: number): number {
  let n = 0
  for (let i = 0; i < hist.length; i++) n += hist[i] || 0
  if (n <= 0) return 0
  const want = Math.max(1, Math.ceil(n * q))
  let seen = 0
  for (let i = 0; i < hist.length; i++) {
    const c = hist[i] || 0
    if (c <= 0) continue
    if (seen + c >= want) {
      const lo = i === 0 ? 0 : LAT_BOUNDS[i - 1]
      const hi =
        i < LAT_BOUNDS.length
          ? LAT_BOUNDS[i]
          : Math.max(lo, max ?? LAT_BOUNDS[LAT_BOUNDS.length - 1] * 2)
      const v = lo + ((hi - lo) * (want - seen)) / c
      const out = Math.round(max != null && max > 0 ? Math.min(v, max) : v)
      return Math.max(0, out)
    }
    seen += c
  }
  return Math.round(max ?? LAT_BOUNDS[LAT_BOUNDS.length - 1])
}

/** "1,2,0,…" ↔ counts (a stored histogram); malformed parts read 0. */
export function histToText(hist: ArrayLike<number>): string {
  return Array.from(hist, (v) => String(Math.max(0, Math.round(v || 0)))).join(',')
}
export function histFromText(s: string | null | undefined): number[] {
  const out = new Array<number>(LAT_BUCKETS).fill(0)
  if (!s) return out
  const parts = String(s).split(',')
  for (let i = 0; i < LAT_BUCKETS && i < parts.length; i++) {
    const n = Number(parts[i])
    out[i] = Number.isFinite(n) && n > 0 ? n : 0
  }
  return out
}

function sortedPct(sorted: number[], q: number): number {
  if (!sorted.length) return 0
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))])
}

// ── #2193 latency distribution ───────────────────────────────────────────────
export interface DistBin {
  /** Lower / upper bound in ms (upper exclusive). */
  lo: number
  hi: number
  n: number
}
export interface DistMode {
  lo: number
  hi: number
  n: number
  /** Share of all requests in this mode (0–1). */
  share: number
  /** Median duration of the requests in this mode. */
  median: number
}
export interface LatencyDistribution {
  total: number
  bins: DistBin[]
  p50: number
  p95: number
  p99: number
  max: number
  modes: DistMode[]
  /** Two clear groups of durations (a fast and a slow path) — a single p95 hides this. */
  bimodal: boolean
}

/** Log-spaced bin edges from 1 ms to past `max`: 4 bins per factor of 10. */
function logEdges(max: number): number[] {
  const edges = [0, 1]
  let e = 1
  const step = 10 ** 0.25
  while (e <= max) {
    e *= step
    edges.push(Math.round(e * 10) / 10)
  }
  return edges
}

/**
 * One route's request durations as a log histogram, and the modes in it: peaks of the lightly
 * smoothed histogram that hold ≥ 8% of the requests each, separated by a valley at most half the
 * smaller peak. Bimodal = two or more such modes.
 */
export function latencyDistribution(latencies: number[]): LatencyDistribution {
  const vals = latencies.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b)
  const total = vals.length
  const max = total ? vals[total - 1] : 0
  const edges = logEdges(Math.max(1, max))
  const bins: DistBin[] = []
  for (let i = 0; i < edges.length - 1; i++) bins.push({ lo: edges[i], hi: edges[i + 1], n: 0 })
  let b = 0
  for (const v of vals) {
    while (b < bins.length - 1 && v >= bins[b].hi) b++
    bins[b].n++
  }
  // Trim empty bins at the top so the chart ends at the slowest request.
  while (bins.length > 1 && bins[bins.length - 1].n === 0) bins.pop()
  const out: LatencyDistribution = {
    total,
    bins,
    p50: sortedPct(vals, 0.5),
    p95: sortedPct(vals, 0.95),
    p99: sortedPct(vals, 0.99),
    max: Math.round(max),
    modes: [],
    bimodal: false
  }
  if (total < 20) return out
  const sm = bins.map(
    (x, i) => (bins[i - 1]?.n ?? 0) * 0.25 + x.n * 0.5 + (bins[i + 1]?.n ?? 0) * 0.25
  )
  const peaks: number[] = []
  for (let i = 0; i < sm.length; i++) {
    const left = i === 0 ? -1 : sm[i - 1]
    const right = i === sm.length - 1 ? -1 : sm[i + 1]
    if (sm[i] > 0 && sm[i] >= left && sm[i] > right) peaks.push(i)
  }
  // Merge peaks with no real valley between them (keep the taller).
  const kept: number[] = []
  for (const p of peaks) {
    const prev = kept[kept.length - 1]
    if (prev == null) {
      kept.push(p)
      continue
    }
    let valley = Number.POSITIVE_INFINITY
    for (let i = prev; i <= p; i++) valley = Math.min(valley, sm[i])
    if (valley <= 0.5 * Math.min(sm[prev], sm[p]) && p - prev >= 2) kept.push(p)
    else if (sm[p] > sm[prev]) kept[kept.length - 1] = p
  }
  // Each mode spans from the valley before it to the valley after it.
  const cuts: number[] = [0]
  for (let k = 1; k < kept.length; k++) {
    let at = kept[k - 1]
    for (let i = kept[k - 1]; i <= kept[k]; i++) if (sm[i] < sm[at]) at = i
    cuts.push(at)
  }
  cuts.push(bins.length)
  const modes: DistMode[] = []
  for (let k = 0; k < kept.length; k++) {
    const from = k === 0 ? 0 : cuts[k] + 1
    const to = k === kept.length - 1 ? bins.length - 1 : cuts[k + 1]
    const lo = bins[from].lo
    const hi = bins[to].hi
    const inMode = vals.filter((v) => v >= lo && (v < hi || to === bins.length - 1))
    if (!inMode.length) continue
    modes.push({
      lo,
      hi,
      n: inMode.length,
      share: Math.round((inMode.length / total) * 1000) / 1000,
      median: sortedPct(inMode, 0.5)
    })
  }
  out.modes = modes.filter((m) => m.share >= 0.08)
  out.bimodal = out.modes.length >= 2
  return out
}

// ── #2252 slow parameters ────────────────────────────────────────────────────
export interface ParamRow {
  latency_ms: number
  query: string | null | undefined
}
export interface SlowFeature {
  /** Stable id (`limit:1001-10000`, `filter.field:status`). */
  feature: string
  /** Plain words ("limit over 1,000", "filter on status"). */
  label: string
  n: number
  slow: number
  /** Slow share of the requests carrying it (0–1). */
  slow_share: number
  /** Its slow share ÷ the slow share of the requests without it. */
  lift: number
  /** Share of all slow requests it accounts for beyond what the others would predict (0–1). */
  explains: number
  median_with: number
  median_without: number
}
export interface SlowParamsReport {
  total: number
  slow: number
  /** The duration a request must reach to count as slow (the route's p90, at least 1 ms). */
  threshold_ms: number
  /** Requests with a query string. */
  with_query: number
  features: SlowFeature[]
}

const DAY_MS = 86_400_000
const DATE_RE = /^\d{4}-\d{2}-\d{2}/
const SKIP_PARAMS = new Set(['_', 't', 'ts', 'cb', 'nocache', 'access_token', 'token'])

function numBucket(n: number): { id: string; label: string } {
  if (n < 0) return { id: 'all', label: 'all rows (-1)' }
  if (n <= 100) return { id: '0-100', label: 'up to 100' }
  if (n <= 1000) return { id: '101-1000', label: '101 to 1,000' }
  if (n <= 10_000) return { id: '1001-10000', label: '1,001 to 10,000' }
  return { id: '10001+', label: 'over 10,000' }
}

function spanBucket(days: number): { id: string; label: string } {
  if (days <= 7) return { id: '<=7d', label: 'a week or less' }
  if (days <= 31) return { id: '<=31d', label: 'up to a month' }
  if (days <= 366) return { id: '<=1y', label: 'up to a year' }
  return { id: '>1y', label: 'more than a year' }
}

/** Field names and date-range spans used in a Directus-style filter object. */
function filterFeatures(raw: string, out: Map<string, string>): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    out.set('filter:unparsed', 'a filter that is not JSON')
    return
  }
  const dates = new Map<string, { lo?: number; hi?: number }>()
  const walk = (node: unknown, field: string | null, depth: number) => {
    if (depth > 6 || !node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const x of node.slice(0, 20)) walk(x, field, depth + 1)
      return
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>).slice(0, 40)) {
      if (k === '_and' || k === '_or') {
        walk(v, field, depth + 1)
        continue
      }
      if (k.startsWith('_')) {
        if (!field) continue
        if (k === '_between' && Array.isArray(v) && v.length === 2) {
          const [a, b] = v.map((x) =>
            typeof x === 'string' && DATE_RE.test(x) ? Date.parse(x) : NaN
          )
          if (Number.isFinite(a) && Number.isFinite(b)) dates.set(field, { lo: a, hi: b })
        } else if ((k === '_gte' || k === '_gt') && typeof v === 'string' && DATE_RE.test(v)) {
          dates.set(field, { ...dates.get(field), lo: Date.parse(v) })
        } else if ((k === '_lte' || k === '_lt') && typeof v === 'string' && DATE_RE.test(v)) {
          dates.set(field, { ...dates.get(field), hi: Date.parse(v) })
        } else if (k === '_contains' || k === '_icontains' || k === '_ncontains') {
          out.set(`filter.contains:${field}`, `a "contains" search on ${field}`)
        } else if (k === '_in' && Array.isArray(v) && v.length > 50) {
          out.set(`filter.in-large:${field}`, `a list of over 50 values on ${field}`)
        }
        continue
      }
      const name = field ? `${field}.${k}` : k
      if (/^[A-Za-z0-9_.]{1,80}$/.test(name)) out.set(`filter.field:${name}`, `filter on ${name}`)
      walk(v, name, depth + 1)
    }
  }
  walk(parsed, null, 0)
  for (const [field, r] of dates) {
    // An open-ended range (only a lower bound) runs to now.
    const lo = r.lo
    const hi = r.hi ?? Date.now()
    if (lo == null || !Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) continue
    const s = spanBucket((hi - lo) / DAY_MS)
    out.set(`filter.range:${field}:${s.id}`, `a date range on ${field} of ${s.label}`)
  }
}

/** The features of one logged query string (masked values never become a feature value). */
export function queryFeatures(query: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!query) return out
  let params: URLSearchParams
  try {
    params = new URLSearchParams(query.replace(/…$/, ''))
  } catch {
    return out
  }
  let n = 0
  for (const [rawName, value] of params) {
    if (++n > 60) break
    const name = rawName.slice(0, 60)
    if (SKIP_PARAMS.has(name.toLowerCase()) || !/^[A-Za-z0-9_.[\]-]{1,60}$/.test(name)) continue
    const base = name.replace(/\[.*$/, '')
    if (base === 'filter' || name.startsWith('filter[')) {
      if (base === 'filter' && value.trim().startsWith('{')) filterFeatures(value, out)
      else {
        const field = name.match(/^filter\[([A-Za-z0-9_]+)\]/)?.[1]
        out.set(
          field ? `filter.field:${field}` : 'filter',
          field ? `filter on ${field}` : 'a filter'
        )
      }
      continue
    }
    const num = Number(value)
    if (
      (base === 'limit' || base === 'offset' || base === 'page') &&
      value !== '' &&
      Number.isFinite(num)
    ) {
      const b = base === 'page' ? numBucket(num * 100) : numBucket(num)
      const label =
        base === 'limit'
          ? `limit ${b.label}`
          : base === 'page'
            ? `page ${num <= 1 ? 1 : num <= 10 ? '2 to 10' : 'past 10'}`
            : `offset ${b.label}`
      const id = base === 'page' ? (num <= 1 ? '1' : num <= 10 ? '2-10' : '11+') : b.id
      out.set(`${base}:${id}`, label)
      continue
    }
    if (base === 'fields') {
      const list = value.split(',').filter(Boolean)
      if (list.some((f) => f === '*' || f.endsWith('.*')))
        out.set('fields:wildcard', 'fields with a * (every field)')
      if (list.some((f) => f.includes('.')))
        out.set('fields:related', 'fields from related records')
      if (list.length > 30) out.set('fields:many', 'more than 30 fields')
      continue
    }
    if (base === 'search' || base === 'q') {
      out.set(`${base}:present`, base === 'q' ? 'a search (q)' : 'a search')
      continue
    }
    if (value.includes('••••')) {
      out.set(`${base}:present`, `${base} given`)
      continue
    }
    // Short, plain values are kept (sort=-date, meta=total_count); anything else is presence only.
    if (value.length <= 40 && /^[A-Za-z0-9_,.:-]*$/.test(value) && !/\d{4,}/.test(value))
      out.set(`${base}=${value}`, `${base}=${value}`)
    else out.set(`${base}:present`, `${base} given`)
  }
  return out
}

/**
 * Which query parameters and filter values go with slow requests on one route. Slow = at or above
 * the route's p90. A feature is ranked by how many slow requests it explains beyond what the slow
 * share of the requests without it would predict; features seen fewer than `minN` times or with a
 * lift under 1.5 are left out.
 */
export function slowParameters(
  rows: ParamRow[],
  opts: { minN?: number; top?: number } = {}
): SlowParamsReport {
  const minN = opts.minN ?? 5
  const top = opts.top ?? 10
  const lat = rows.map((r) => r.latency_ms).filter((v) => Number.isFinite(v))
  const sorted = lat.slice().sort((a, b) => a - b)
  const threshold = Math.max(1, sortedPct(sorted, 0.9))
  const total = rows.length
  const isSlow = rows.map((r) => r.latency_ms >= threshold)
  const slow = isSlow.filter(Boolean).length
  const feats = rows.map((r) => queryFeatures(r.query))
  const withQuery = rows.filter((r) => !!r.query).length
  const report: SlowParamsReport = {
    total,
    slow,
    threshold_ms: threshold,
    with_query: withQuery,
    features: []
  }
  if (total < 20 || slow === 0) return report
  const stats = new Map<string, { label: string; idx: number[] }>()
  feats.forEach((f, i) => {
    for (const [id, label] of f) {
      let s = stats.get(id)
      if (!s) {
        if (stats.size >= 2000) continue
        s = { label, idx: [] }
        stats.set(id, s)
      }
      s.idx.push(i)
    }
  })
  const median = (idx: number[]) =>
    sortedPct(
      idx.map((i) => rows[i].latency_ms).sort((a, b) => a - b),
      0.5
    )
  const out: SlowFeature[] = []
  for (const [id, s] of stats) {
    const n = s.idx.length
    if (n < minN || n === total) continue
    const slowWith = s.idx.filter((i) => isSlow[i]).length
    const nWithout = total - n
    const slowWithout = slow - slowWith
    const shareWith = slowWith / n
    const shareWithout = nWithout > 0 ? slowWithout / nWithout : 0
    const lift = shareWithout > 0 ? shareWith / shareWithout : shareWith > 0 ? 99 : 0
    const excess = slowWith - n * shareWithout
    if (lift < 1.5 || excess <= 0) continue
    const inSet = new Set(s.idx)
    const without: number[] = []
    for (let i = 0; i < total; i++) if (!inSet.has(i)) without.push(i)
    out.push({
      feature: id,
      label: s.label,
      n,
      slow: slowWith,
      slow_share: Math.round(shareWith * 1000) / 1000,
      lift: Math.round(Math.min(99, lift) * 100) / 100,
      explains: Math.round((excess / slow) * 1000) / 1000,
      median_with: median(s.idx),
      median_without: median(without)
    })
  }
  out.sort(
    (a, b) => b.explains - a.explains || b.lift - a.lift || a.feature.localeCompare(b.feature)
  )
  report.features = out.slice(0, top)
  return report
}

// ── #2165 jobs against peaks ─────────────────────────────────────────────────
export interface JobInput {
  id: string
  expression: string
  heavy?: boolean
  /** IANA zone the expression runs in. */
  timezone?: string
  /** Completed scheduled runs (UTC start epoch ms + duration ms), newest first or any order. */
  runs: Array<{ at: number; ms: number }>
}
export interface JobSlot {
  id: string
  heavy: boolean
  expression: string
  timezone: string | null
  runs: number
  /** Runs per day on average over the sampled days. */
  per_day: number
  /** Median duration (ms). */
  median_ms: number
  /** The UTC minute of day it usually starts (null = no clear time: it runs all day). */
  start_minute_utc: number | null
  /** Average requests per minute across its usual run window. */
  traffic_during: number
  /** True when its usual window sits in the day's peak. */
  overlaps_peak: boolean
  /** A quieter start (UTC minute of day) of the same length, when overlapping a peak. */
  suggest_minute_utc: number | null
  /** The suggested start as a daily cron expression in the job's zone. */
  suggest_expression: string | null
  /** Traffic at the suggested slot (requests per minute). */
  suggest_traffic: number | null
}
export interface JobsAgainstPeaks {
  /** Requests per minute for each hour of the (UTC) day, averaged over the sampled days. */
  curve: number[]
  /** The level from which an hour counts as a peak (see jobsAgainstPeaks). */
  peak_level: number
  jobs: JobSlot[]
}

/** Offset (minutes, east positive) of `tz` at `at`; 0 for an unknown zone. */
export function zoneOffsetMinutes(tz: string | undefined | null, at = Date.now()): number {
  if (!tz) return 0
  try {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
    const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]))
    const asUtc = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute)
    )
    return Math.round((asUtc - Math.floor(at / 60_000) * 60_000) / 60_000)
  } catch {
    return 0
  }
}

/** Mean of `curve` (per hour) over the window starting at minute `start` lasting `len` minutes. */
function windowLevel(curve: number[], start: number, len: number): number {
  const minutes = Math.max(1, Math.min(1440, Math.round(len)))
  let sum = 0
  for (let k = 0; k < minutes; k++) {
    const m = (((start + k) % 1440) + 1440) % 1440
    sum += curve[Math.floor(m / 60)] ?? 0
  }
  return sum / minutes
}

/** The circular median of start minutes (minutes of day), or null when they spread over the day. */
function usualStart(minutes: number[]): number | null {
  if (!minutes.length) return null
  // Pick the start that most other starts sit within 45 minutes of.
  let best = minutes[0]
  let bestN = -1
  for (const m of minutes) {
    const n = minutes.filter((x) => Math.min(Math.abs(x - m), 1440 - Math.abs(x - m)) <= 45).length
    if (n > bestN) {
      best = m
      bestN = n
    }
  }
  return bestN >= Math.ceil(minutes.length * 0.6) ? best : null
}

/**
 * Scheduled jobs over the day's traffic: each job's usual start and length (from its recent runs),
 * the traffic across that window, and — when it sits in the day's peak — the
 * quietest start of the same length, on the quarter hour. Jobs that run more than four times a
 * day are listed without a slot (they run all day; moving them is not a choice of hour).
 */
export function jobsAgainstPeaks(
  curve: number[],
  jobs: JobInput[],
  opts: { days: number; now?: number }
): JobsAgainstPeaks {
  const c = Array.from({ length: 24 }, (_, i) => Math.max(0, Number(curve[i]) || 0))
  const sorted = c.slice().sort((a, b) => a - b)
  // Peak: halfway between the 75th percentile and the busiest hour, and clearly above the median
  // hour — a flat day has no peak to move away from.
  const p75 = sorted[Math.floor(sorted.length * 0.75)] ?? 0
  const median = sorted[12] ?? 0
  const peakLevel = Math.max((p75 + (sorted[23] ?? 0)) / 2, median * 1.25)
  const days = Math.max(1, opts.days)
  const now = opts.now ?? Date.now()
  const slots: JobSlot[] = []
  for (const j of jobs) {
    const runs = j.runs.filter((r) => Number.isFinite(r.at) && Number.isFinite(r.ms) && r.ms >= 0)
    if (!runs.length) continue
    const durations = runs.map((r) => r.ms).sort((a, b) => a - b)
    const medianMs = sortedPct(durations, 0.5)
    const perDay = Math.round((runs.length / days) * 10) / 10
    const startMinutes = runs.map((r) => {
      const d = new Date(r.at)
      return d.getUTCHours() * 60 + d.getUTCMinutes()
    })
    const frequent = perDay > 4
    const start = frequent ? null : usualStart(startMinutes)
    const lenMin = Math.max(1, medianMs / 60_000)
    const during = start == null ? windowLevel(c, 0, 1440) : windowLevel(c, start, lenMin)
    const overlaps = start != null && peakLevel > 0 && during >= peakLevel
    let suggest: number | null = null
    let suggestTraffic: number | null = null
    if (overlaps) {
      let best = start as number
      let bestLevel = during
      for (let m = 0; m < 1440; m += 15) {
        const lvl = windowLevel(c, m, lenMin)
        if (lvl < bestLevel - 1e-9) {
          best = m
          bestLevel = lvl
        }
      }
      // Only worth suggesting when the slot is clearly quieter (a quarter less traffic or more).
      if (best !== start && bestLevel <= during * 0.75) {
        suggest = best
        suggestTraffic = Math.round(bestLevel * 10) / 10
      }
    }
    let expr: string | null = null
    if (suggest != null) {
      const local = (((suggest + zoneOffsetMinutes(j.timezone, now)) % 1440) + 1440) % 1440
      const dow = j.expression.trim().split(/\s+/)[4]
      const dowPart = dow && dow !== '*' && /^[0-9A-Za-z,-]+$/.test(dow) ? dow : '*'
      expr = `${local % 60} ${Math.floor(local / 60)} * * ${dowPart}`
    }
    slots.push({
      id: j.id,
      heavy: !!j.heavy,
      expression: j.expression,
      timezone: j.timezone ?? null,
      runs: runs.length,
      per_day: perDay,
      median_ms: medianMs,
      start_minute_utc: start,
      traffic_during: Math.round(during * 10) / 10,
      overlaps_peak: overlaps,
      suggest_minute_utc: suggest,
      suggest_expression: expr,
      suggest_traffic: suggestTraffic
    })
  }
  slots.sort(
    (a, b) =>
      Number(b.overlaps_peak) - Number(a.overlaps_peak) ||
      b.median_ms - a.median_ms ||
      a.id.localeCompare(b.id)
  )
  return {
    curve: c.map((v) => Math.round(v * 10) / 10),
    peak_level: Math.round(peakLevel * 10) / 10,
    jobs: slots
  }
}

// ── #2151 what-if capacity ───────────────────────────────────────────────────
export interface WhatIfInput {
  /** This process's request rate now (req/s). */
  now_rps: number
  /** What one replica can carry (req/s): configured or the busiest minute measured. */
  ceiling_rps: number | null
  /** Serving replicas now (≥ 1). */
  replicas: number
  pool_used: number
  pool_max: number
  /** Pool connections in use per request/s (null = not measurable at this load). */
  pool_per_rps: number | null
  /** Event-loop p99 lag now (ms; null = not measured). */
  loop_p99_ms: number | null
}
export interface WhatIfScenario {
  /** Traffic change in percent (+50 = half as much again; −30 = a third less). */
  traffic_pct: number
  /** Replicas added (or removed, negative). */
  add_replicas: number
  /** Connections a moved job holds while it runs, added at its new slot and removed at its old. */
  move_job?: {
    id: string
    /** Requests per minute at its current slot / at the new slot (the day's curve). */
    from_rpm: number
    to_rpm: number
    connections?: number
  } | null
}
export interface WhatIfFigures {
  rps_per_replica: number
  headroom_pct: number | null
  pool_used: number
  pool_pct: number | null
  loop_p99_ms: number | null
  /** The pool or the ceiling would be passed. */
  saturated: boolean
}
export interface WhatIfResult {
  now: WhatIfFigures
  projected: WhatIfFigures
  replicas: { now: number; projected: number }
  /** For a moved job: its old slot without it and its new slot with it. */
  job?: {
    id: string
    from_before: WhatIfFigures
    from_after: WhatIfFigures
    to_before: WhatIfFigures
    to_after: WhatIfFigures
  }
  notes: string[]
}

const r2 = (v: number) => Math.round(v * 100) / 100

/**
 * Projected headroom, pool pressure and event-loop lag under a scenario, from today's costs per
 * request: pool use scales with each replica's request rate (pool connections per req/s), the
 * ceiling is per replica, and loop lag follows a queue's u/(1−u) curve anchored at today's lag
 * and utilisation. A rough guide, not a load test.
 */
export function projectWhatIf(input: WhatIfInput, s: WhatIfScenario): WhatIfResult {
  const replicas = Math.max(1, Math.round(input.replicas || 1))
  const projReplicas = Math.max(1, replicas + Math.round(s.add_replicas || 0))
  const pct = Math.max(-95, Math.min(1000, Number(s.traffic_pct) || 0))
  const nowRps = Math.max(0, input.now_rps || 0)
  const ceiling = input.ceiling_rps && input.ceiling_rps > 0 ? input.ceiling_rps : null
  const poolMax = Math.max(0, input.pool_max || 0)
  const perRps =
    input.pool_per_rps != null && input.pool_per_rps > 0
      ? input.pool_per_rps
      : nowRps > 0.05 && input.pool_used > 0
        ? input.pool_used / nowRps
        : null
  const notes: string[] = []
  const u0 = ceiling ? Math.min(0.95, Math.max(0.01, nowRps / ceiling)) : null
  const lagAt = (rps: number): number | null => {
    if (input.loop_p99_ms == null || !ceiling || u0 == null) return null
    const u = rps / ceiling
    if (u >= 0.98) return null
    const k = u / (1 - u) / (u0 / (1 - u0))
    return Math.round(Math.max(0, input.loop_p99_ms * Math.max(k, 0.25)) * 10) / 10
  }
  const figures = (rps: number, extraConn = 0, baseUsed?: number): WhatIfFigures => {
    const used =
      perRps != null
        ? perRps * rps + extraConn
        : Math.max(0, (baseUsed ?? input.pool_used) + extraConn)
    const headroom = ceiling ? Math.round((100 * rps) / ceiling) : null
    const poolPct = poolMax > 0 ? Math.round((100 * used) / poolMax) : null
    return {
      rps_per_replica: r2(rps),
      headroom_pct: headroom,
      pool_used: r2(used),
      pool_pct: poolPct,
      loop_p99_ms: lagAt(rps),
      saturated: (headroom != null && headroom >= 100) || (poolPct != null && poolPct >= 100)
    }
  }
  const totalNow = nowRps * replicas
  const projRps = (totalNow * (1 + pct / 100)) / projReplicas
  const now = figures(nowRps, 0, input.pool_used)
  const projected = figures(projRps)
  if (!ceiling) notes.push('No ceiling is known yet, so headroom and loop lag cannot be projected.')
  if (perRps == null)
    notes.push(
      'Pool use per request could not be measured at this load; pool figures stay as today.'
    )
  if (ceiling && projRps / ceiling >= 0.98)
    notes.push('Past what one replica has carried: the event loop would queue without bound.')
  if (projected.pool_pct != null && projected.pool_pct >= 100)
    notes.push('The pool would be full: requests would wait for a connection.')
  const out: WhatIfResult = {
    now,
    projected,
    replicas: { now: replicas, projected: projReplicas },
    notes
  }
  const mj = s.move_job
  if (mj) {
    const conn = Math.max(0, mj.connections ?? 1)
    const scale = (1 + pct / 100) / projReplicas
    const fromRps = (Math.max(0, mj.from_rpm) / 60) * scale
    const toRps = (Math.max(0, mj.to_rpm) / 60) * scale
    out.job = {
      id: mj.id,
      from_before: figures(fromRps, conn),
      from_after: figures(fromRps, 0),
      to_before: figures(toRps, 0),
      to_after: figures(toRps, conn)
    }
  }
  return out
}

// ── #2183 time-lapse frames ──────────────────────────────────────────────────
export interface TimelapseGroup {
  /** Step index from the start of the range. */
  s: number
  /** Node key (`e:<lane>/<entity>`, `c:<caller>`, `d:<down>`). */
  key: string
  n: number
  e: number
  /** p95 (ms) of that node in that step (approximate when rolled up). */
  p95: number
}
export interface TimelapseFrame {
  /** Epoch ms of the step start. */
  t: number
  req: number
  err: number
  /** [node index, requests, errors, p95] for the nodes active in this step. */
  nodes: Array<[number, number, number, number]>
}
export interface Timelapse {
  from: number
  to: number
  step_s: number
  /** The nodes that appear, busiest first (indexes used by frames). */
  nodes: Array<{ key: string; n: number; e: number }>
  frames: TimelapseFrame[]
}

/** Grouped counts → one frame per step, keeping the `top` busiest nodes (the rest fold into totals). */
export function buildTimelapse(
  groups: TimelapseGroup[],
  range: { from: number; to: number; stepS: number },
  top = 40
): Timelapse {
  const steps = Math.max(1, Math.ceil((range.to - range.from) / (range.stepS * 1000)))
  const totals = new Map<string, { n: number; e: number }>()
  for (const g of groups) {
    if (g.s < 0 || g.s >= steps) continue
    const t = totals.get(g.key) ?? { n: 0, e: 0 }
    t.n += g.n
    t.e += g.e
    totals.set(g.key, t)
  }
  const nodes = [...totals]
    .filter(([k]) => k.startsWith('e:') || k.startsWith('d:') || k.startsWith('c:'))
    .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([key, v]) => ({ key, n: v.n, e: v.e }))
  const index = new Map(nodes.map((n, i) => [n.key, i]))
  const frames: TimelapseFrame[] = Array.from({ length: steps }, (_, i) => ({
    t: range.from + i * range.stepS * 1000,
    req: 0,
    err: 0,
    nodes: []
  }))
  const cells = new Map<string, [number, number, number, number]>()
  for (const g of groups) {
    if (g.s < 0 || g.s >= steps) continue
    // Request totals come from entity nodes only (callers and partners would count twice).
    if (g.key.startsWith('e:')) {
      frames[g.s].req += g.n
      frames[g.s].err += g.e
    }
    const i = index.get(g.key)
    if (i == null) continue
    const ck = `${g.s}|${i}`
    const cell = cells.get(ck)
    if (cell) {
      cell[3] =
        cell[1] + g.n > 0 ? Math.round((cell[3] * cell[1] + g.p95 * g.n) / (cell[1] + g.n)) : 0
      cell[1] += g.n
      cell[2] += g.e
    } else {
      const c: [number, number, number, number] = [i, g.n, g.e, Math.round(g.p95)]
      cells.set(ck, c)
      frames[g.s].nodes.push(c)
    }
  }
  return { from: range.from, to: range.to, step_s: range.stepS, nodes, frames }
}
