// api/src/services/traffic-correlation.ts
/**
 * #1149 — correlated spikes. When two entities rise together again and again over the 15-minute
 * ring, one probably drives the other (a page that loads a widget, an import that writes two
 * collections). Pure functions over request series; the route feeds them the busiest entities.
 *
 * Bounded by construction: only the `TOP_N` busiest entities are compared (N² / 2 pairs of
 * `points` buckets each), so the cost does not grow with the number of entities on the node.
 */

export const TOP_N = 24
/** 5-second buckets over 15 minutes: fine enough to line spikes up, coarse enough to be stable. */
export const POINTS = 180
export const MIN_R = 0.6
export const MIN_CO_SPIKES = 3
export const MAX_PAIRS = 12

export interface SeriesRow {
  key: string
  total: number
  series: number[]
}
export interface Correlation {
  a: string
  b: string
  /** Pearson correlation of the two request series, 0..1 (negative pairs are never returned). */
  r: number
  /** Buckets where BOTH were above their own mean + 1 standard deviation. */
  co_spikes: number
  /** Which one moved first on average across the co-spikes: 'a', 'b' or null (together). */
  leads: 'a' | 'b' | null
}

function stats(s: number[]): { mean: number; sd: number } {
  const n = s.length || 1
  const mean = s.reduce((a, b) => a + b, 0) / n
  let v = 0
  for (const x of s) v += (x - mean) ** 2
  return { mean, sd: Math.sqrt(v / n) }
}

export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 3) return 0
  const sa = stats(a.slice(0, n))
  const sb = stats(b.slice(0, n))
  if (sa.sd === 0 || sb.sd === 0) return 0
  let cov = 0
  for (let i = 0; i < n; i++) cov += (a[i] - sa.mean) * (b[i] - sb.mean)
  return cov / n / (sa.sd * sb.sd)
}

/** Indices where the series is above its mean + 1 sd (a spike). */
export function spikes(s: number[]): number[] {
  const { mean, sd } = stats(s)
  if (sd === 0) return []
  const out: number[] = []
  for (let i = 0; i < s.length; i++) if (s[i] > mean + sd) out.push(i)
  return out
}

/** The pairs that rise together, strongest first. */
export function correlate(rows: SeriesRow[], opts: { minR?: number; minCo?: number } = {}) {
  const minR = opts.minR ?? MIN_R
  const minCo = opts.minCo ?? MIN_CO_SPIKES
  const top = rows.slice(0, TOP_N)
  const sp = top.map((r) => spikes(r.series))
  const out: Correlation[] = []
  for (let i = 0; i < top.length; i++) {
    if (sp[i].length < minCo) continue
    for (let j = i + 1; j < top.length; j++) {
      if (sp[j].length < minCo) continue
      const r = pearson(top[i].series, top[j].series)
      if (r < minR) continue
      // co-spike: a spike of A within one bucket of a spike of B
      const bSet = new Set(sp[j])
      let co = 0
      let lead = 0
      for (const x of sp[i]) {
        if (bSet.has(x)) co++
        else if (bSet.has(x + 1)) {
          co++
          lead-- // A spiked one bucket before B
        } else if (bSet.has(x - 1)) {
          co++
          lead++
        }
      }
      if (co < minCo) continue
      out.push({
        a: top[i].key,
        b: top[j].key,
        r: Math.round(r * 100) / 100,
        co_spikes: co,
        leads: lead < 0 ? 'a' : lead > 0 ? 'b' : null
      })
    }
  }
  return out.sort((x, y) => y.r - x.r || y.co_spikes - x.co_spikes).slice(0, MAX_PAIRS)
}
