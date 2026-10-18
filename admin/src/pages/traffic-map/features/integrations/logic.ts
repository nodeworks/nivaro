// Pure helpers for the integrations features (#2162 #2189 #2198 #2277).

export interface BusinessSeries {
  key: string
  label: string
  points: number[]
  total: number
  unavailable?: boolean
  truncated?: boolean
}
export interface BusinessEvents {
  from: number
  minutes: number
  series: BusinessSeries[]
  collections: Array<{ collection: string; created: number }>
}

export interface Verdict {
  kind: 'business-drop' | 'both-quiet' | 'ok'
  /** Series keys that dropped. */
  drops: string[]
  text: string | null
}

/** A series needs this many events a minute earlier on to count as one that can "drop". */
export const MIN_BASELINE = 0.5
/** Recent activity below this share of the earlier rate is a drop. */
export const DROP_SHARE = 0.4
/** API traffic above this share of its earlier rate counts as normal. */
export const NORMAL_SHARE = 0.7
const RECENT = 3

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0)

/** [earlier mean, recent mean] of a per-minute series; the minute in progress is left out. */
export function recentVsEarlier(points: number[]): [number, number] | null {
  const done = points.slice(0, -1)
  if (done.length < RECENT + 3) return null
  return [mean(done.slice(0, -RECENT)), mean(done.slice(-RECENT))]
}

const noun = (label: string) => label.charAt(0).toLowerCase() + label.slice(1)
const per = (n: number) => `${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10}/min`

/**
 * Tell a quiet API from quiet business. `tech` = API requests per minute over the same minutes
 * (oldest first). A business series that fell to under DROP_SHARE of its earlier rate while the
 * API held above NORMAL_SHARE is the case worth a sentence: requests look normal, the business
 * does not.
 */
export function businessVerdict(tech: number[], series: BusinessSeries[]): Verdict {
  const t = recentVsEarlier(tech)
  const techNormal = t ? t[0] <= 0 || t[1] >= t[0] * NORMAL_SHARE : true
  const techQuiet = t ? t[0] > 0 && t[1] < t[0] * DROP_SHARE : false
  const dropped: Array<{ s: BusinessSeries; was: number; now: number }> = []
  for (const s of series) {
    if (s.unavailable) continue
    const r = recentVsEarlier(s.points)
    if (!r || r[0] < MIN_BASELINE) continue
    if (r[1] < r[0] * DROP_SHARE) dropped.push({ s, was: r[0], now: r[1] })
  }
  if (dropped.length && techNormal) {
    const d = dropped[0]
    const more = dropped.length > 1 ? ` (and ${dropped.length - 1} more)` : ''
    return {
      kind: 'business-drop',
      drops: dropped.map((x) => x.s.key),
      text: `${d.s.label} dropped to ${per(d.now)} from ${per(d.was)}${more} while API traffic looks normal.`
    }
  }
  if (techQuiet && dropped.length) {
    return {
      kind: 'both-quiet',
      drops: dropped.map((x) => x.s.key),
      text: `API traffic and business activity are both down; ${noun(dropped[0].s.label)} fell to ${per(dropped[0].now)}.`
    }
  }
  return { kind: 'ok', drops: [], text: null }
}

/** "3 h 20 min", "14 min", "40 s". */
export function fmtSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
}
