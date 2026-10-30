/**
 * Command Center "work" maths — pure functions only (no I/O), so the flow, attention, workload
 * and forecast reads share one definition of every figure and the tests pin them down.
 */

export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

export function median(values: number[]): number | null {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (v.length === 0) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

const round1 = (n: number) => Math.round(n * 10) / 10

/**
 * Ages of the records sitting in one state, as of `nowMs`: the oldest and median time in the
 * state (seconds) and how many passed the stuck threshold. Entry times in the future (clock skew)
 * count as zero age.
 */
export function ageStats(
  enteredAtMs: number[],
  nowMs: number,
  stuckDays: number
): { oldest_age_s: number | null; median_age_s: number | null; stuck: number } {
  if (enteredAtMs.length === 0) return { oldest_age_s: null, median_age_s: null, stuck: 0 }
  const ages = enteredAtMs.map((t) => Math.max(0, nowMs - t))
  const stuckMs = stuckDays * DAY_MS
  const med = median(ages)
  return {
    oldest_age_s: Math.round(Math.max(...ages) / 1000),
    median_age_s: med == null ? null : Math.round(med / 1000),
    stuck: ages.filter((a) => a > stuckMs).length
  }
}

/**
 * Days to clear `open` records at the pace of the last 7 days' completions. 0 when nothing is
 * open; null when nothing was completed in the window (it is not clearing at all).
 */
export function clearsInDays(open: number, completed7d: number): number | null {
  if (open <= 0) return 0
  if (completed7d <= 0) return null
  return round1(open / (completed7d / 7))
}

/** Open-count change over the window: what arrived minus what finished. */
export function wipDelta(arrivals: number, completions: number): number {
  return arrivals - completions
}

// ── Attention ranking ─────────────────────────────────────────────────────────────────────────

export type Severity = 'critical' | 'warning' | 'info'
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 }

/** Severity first (critical → info), then the oldest first, then the larger count. */
export function rankAttention<
  T extends { severity: Severity; since?: string | null; count?: number | null; id: string }
>(items: T[]): T[] {
  const t = (s: string | null | undefined) => {
    const ms = s ? new Date(s).getTime() : Number.NaN
    return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY
  }
  return [...items].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      t(a.since) - t(b.since) ||
      (b.count ?? 0) - (a.count ?? 0) ||
      a.id.localeCompare(b.id)
  )
}

// ── Workload ──────────────────────────────────────────────────────────────────────────────────

/**
 * Over = clearly above their usual (half again as much and at least 3 more); idle = nothing open
 * while someone usually has work; otherwise normal.
 */
export function workloadStatus(open: number, usual: number): 'over' | 'normal' | 'idle' {
  if (open === 0) return usual > 0 ? 'idle' : 'normal'
  if (open >= usual * 1.5 && open - usual >= 3) return 'over'
  return 'normal'
}

// ── Forecast ──────────────────────────────────────────────────────────────────────────────────

/** Per hour (0..23), the mean of the same hour over the past days given (each day = 24 counts). */
export function expectedByHour(pastDays: number[][]): number[] {
  const out = new Array(24).fill(0) as number[]
  if (pastDays.length === 0) return out
  for (const day of pastDays) for (let h = 0; h < 24; h++) out[h] += day[h] ?? 0
  return out.map((v) => round1(v / pastDays.length))
}

/** What the expected curve adds up to by `hour` + `fraction` of the current hour. */
export function expectedSoFar(byHour: number[], hour: number, fraction: number): number {
  let sum = 0
  for (let h = 0; h < hour && h < 24; h++) sum += byHour[h] ?? 0
  if (hour >= 0 && hour < 24) sum += (byHour[hour] ?? 0) * Math.min(1, Math.max(0, fraction))
  return round1(sum)
}

/**
 * Falling behind: today's backlog growth (arrivals − completions so far) is larger than the usual
 * growth by this time of day, by more than a band of max(3, 20% of the day's arrivals so far).
 */
export function isBehind(f: {
  arrivals_so_far: number
  completions_so_far: number
  arrivals_expected: number
  completions_expected: number
}): boolean {
  const actualGap = f.arrivals_so_far - f.completions_so_far
  const usualGap = f.arrivals_expected - f.completions_expected
  const band = Math.max(3, 0.2 * Math.max(f.arrivals_expected, f.arrivals_so_far))
  return actualGap - usualGap > band
}

/**
 * One formatter per zone. Building an Intl.DateTimeFormat costs far more than formatting with
 * one: the forecast buckets up to 100k instants, and a new formatter per instant held the event
 * loop for ~50 s on staging (2026-10-30). Zones are validated names, so the map stays small; the
 * cap only guards against a caller looping over odd zones.
 */
const ZONE_FORMATS = new Map<string, Intl.DateTimeFormat | null>()
const ZONE_FORMATS_MAX = 200
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function zoneFormat(tz: string): Intl.DateTimeFormat | null {
  let fmt = ZONE_FORMATS.get(tz)
  if (fmt !== undefined) return fmt
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23'
    })
  } catch {
    fmt = null
  }
  if (ZONE_FORMATS.size >= ZONE_FORMATS_MAX) ZONE_FORMATS.clear()
  ZONE_FORMATS.set(tz, fmt)
  return fmt
}

/** Local calendar parts of an instant in an IANA time zone (falls back to UTC). */
export function localParts(
  ms: number,
  tz: string
): { ymd: string; hour: number; minute: number; weekday: number } {
  const fmt = zoneFormat(tz)
  if (!fmt) return localParts(ms, 'UTC')
  const p: Record<string, string> = {}
  for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value
  return {
    ymd: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    weekday: WEEKDAYS.indexOf(p.weekday)
  }
}

/** The UTC instant of local midnight on `ymd` in `tz` (DST-safe to the hour). */
export function zonedMidnightUtc(ymd: string, tz: string): number {
  const [y, m, d] = ymd.split('-').map(Number)
  let guess = Date.UTC(y, m - 1, d)
  // Two passes settle the zone offset, including on a DST change day.
  for (let i = 0; i < 2; i++) {
    const p = localParts(guess, tz)
    const [py, pm, pd] = p.ymd.split('-').map(Number)
    const asUtc = Date.UTC(py, pm - 1, pd, p.hour, p.minute)
    guess += Date.UTC(y, m - 1, d) - asUtc
  }
  return guess
}

export function validTimeZone(tz: unknown): string {
  if (typeof tz !== 'string' || !tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz))
    return 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return 'UTC'
  }
}

/** Bucket instants into the 24 local hours of `ymd` (instants on other days are ignored). */
export function bucketByLocalHour(instants: number[], ymd: string, tz: string): number[] {
  return bucketDaysByLocalHour(instants, [ymd], tz).get(ymd) as number[]
}

/** bucketByLocalHour for several days in one pass over the instants (each read once). */
export function bucketDaysByLocalHour(
  instants: number[],
  ymds: string[],
  tz: string
): Map<string, number[]> {
  const out = new Map(ymds.map((d) => [d, new Array(24).fill(0) as number[]]))
  for (const ms of instants) {
    const p = localParts(ms, tz)
    const day = out.get(p.ymd)
    if (day) day[p.hour] += 1
  }
  return out
}

// ── Region lens ───────────────────────────────────────────────────────────────────────────────

/**
 * Narrow ids to a region's members. `inRegion` null = this collection cannot be placed, so the
 * read answers for everywhere and says the focus does not apply. Ids compare case-insensitively
 * (uuid spellings differ between tables).
 */
export function narrowToRegion<T>(
  rows: T[],
  idOf: (row: T) => string,
  inRegion: Set<string> | null
): { rows: T[]; applies: boolean } {
  if (!inRegion) return { rows, applies: false }
  const upper = new Set([...inRegion].map((s) => s.toUpperCase()))
  return { rows: rows.filter((r) => upper.has(idOf(r).toUpperCase())), applies: true }
}
