// api/src/services/traffic-taps/util.ts
/**
 * Helpers shared by the topology taps (group C of the Traffic Map follow-ups): where the current
 * call belongs on the map, and a keyed per-minute total that does not saturate (MinuteCounter
 * holds Uint16 counts — fine for request counts, too small for tokens, bytes or Redis commands).
 */
import { currentTraceMeta } from '../request-trace.js'
import { classifyRequest, entityKey } from '../traffic-entities.js'
import { MINUTE_BUCKETS, OTHER_KEY } from '../traffic-ring.js'

/**
 * `<lane>/<entity>` of the request the current call runs inside (the same classification the
 * map gives partner calls: GET first, then POST for routes only POST names), or null outside one.
 */
export function currentEntityKey(): string | null {
  const hint = currentTraceMeta()?.urlHint
  if (!hint) return null
  try {
    let c = classifyRequest({ method: 'GET', path: hint })
    if (!c || c.lane === 'other') {
      const p = classifyRequest({ method: 'POST', path: hint })
      if (p && (!c || p.lane !== 'other')) c = p
    }
    return c ? entityKey(c.lane, c.entity) : null
  } catch {
    return null
  }
}

interface TotalsSeries {
  /** Minute number per bucket (-1 = empty). */
  m: Int32Array
  v: Float64Array
}

/** Keyed per-minute float totals over MINUTE_BUCKETS minutes, `cap` keys + an `__other__` row. */
export class MinuteTotals {
  private map = new Map<string, TotalsSeries>()
  constructor(private cap = 40) {}

  add(key: string, sec: number, n = 1): void {
    if (!Number.isFinite(n) || n === 0) return
    let s = this.map.get(key)
    if (!s) {
      if (this.map.size >= this.cap) {
        this.sweep(sec)
        if (this.map.size >= this.cap) key = OTHER_KEY
      }
      s = this.map.get(key)
      if (!s) {
        s = { m: new Int32Array(MINUTE_BUCKETS).fill(-1), v: new Float64Array(MINUTE_BUCKETS) }
        this.map.set(key, s)
      }
    }
    const min = Math.floor(sec / 60)
    const i = min % MINUTE_BUCKETS
    if (s.m[i] !== min) {
      s.m[i] = min
      s.v[i] = 0
    }
    s.v[i] += n
  }

  /** Total over the minutes the window touches (minute resolution, like MinuteCounter). */
  sum(key: string, windowS: number, sec: number): number {
    const s = this.map.get(key)
    return s ? sumSeries(s, windowS, sec) : 0
  }

  /** Every key with a non-zero total in the window, biggest first. */
  entries(windowS: number, sec: number): Array<[string, number]> {
    const out: Array<[string, number]> = []
    for (const [k, s] of this.map) {
      const v = sumSeries(s, windowS, sec)
      if (v) out.push([k, v])
    }
    return out.sort((a, b) => b[1] - a[1])
  }

  keys(): string[] {
    return [...this.map.keys()]
  }
  get size(): number {
    return this.map.size
  }
  clear(): void {
    this.map.clear()
  }
  /** Drop keys idle for the whole window. */
  sweep(sec: number): number {
    const cur = Math.floor(sec / 60)
    let removed = 0
    for (const [k, s] of this.map) {
      let newest = -1
      for (let i = 0; i < MINUTE_BUCKETS; i++) if (s.m[i] > newest) newest = s.m[i]
      if (newest < cur - (MINUTE_BUCKETS - 1)) {
        this.map.delete(k)
        removed++
      }
    }
    return removed
  }
}

function sumSeries(s: TotalsSeries, windowS: number, sec: number): number {
  const cur = Math.floor(sec / 60)
  const span = Math.max(1, Math.min(MINUTE_BUCKETS, Math.ceil(windowS / 60)))
  let total = 0
  for (let i = 0; i < MINUTE_BUCKETS; i++) {
    const m = s.m[i]
    if (m >= 0 && m > cur - span && m <= cur) total += s.v[i]
  }
  return total
}

/** p-th percentile of a sample (0 when empty). */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const a = values.slice().sort((x, y) => x - y)
  return Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))])
}

/** A bounded latency sample (newest `cap` values). */
export class LatencySample {
  private buf: number[] = []
  constructor(private cap = 200) {}
  push(ms: number): void {
    if (!Number.isFinite(ms)) return
    this.buf.push(ms)
    if (this.buf.length > this.cap) this.buf.shift()
  }
  p(p: number): number {
    return percentile(this.buf, p)
  }
  get size(): number {
    return this.buf.length
  }
}
