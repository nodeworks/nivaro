// api/src/services/traffic-ring.ts
/**
 * Bounded counter primitives behind the Traffic Map (and its taps): a per-second ring of N slots
 * over RING_SECONDS, and per-minute keyed counters over MINUTE_BUCKETS minutes with a key cap and
 * an `__other__` overflow row. Memory only, never throws on a normal call.
 */

export const RING_SECONDS = 900
export const MINUTE_BUCKETS = 15
export const TOP_KEYS_CAP = 20
export const OTHER_KEY = '__other__'

/** A per-second ring: `counts` holds RING_SECONDS × slots cells. */
export interface CountRing {
  counts: Int32Array
  /** Last second written (for gap zeroing). */
  lastSec: number
  touchedSec: number
}

/** Zero every slot between the ring's last write and `sec` (a quiet gap must read as zeros). */
export function ringCatchUp(r: CountRing, sec: number, slots: number): void {
  if (sec <= r.lastSec) return
  const gap = Math.min(sec - r.lastSec, RING_SECONDS)
  for (let i = 1; i <= gap; i++) {
    const idx = ((r.lastSec + i) % RING_SECONDS) * slots
    r.counts.fill(0, idx, idx + slots)
  }
  r.lastSec = sec
}

/** Add `n` to `slot` at `sec`; a second older than the ring holds is ignored. */
export function ringBump(r: CountRing, sec: number, slot: number, slots: number, n = 1): void {
  if (sec < r.lastSec - (RING_SECONDS - 1)) return
  ringCatchUp(r, sec, slots)
  r.counts[(sec % RING_SECONDS) * slots + slot] += n
  r.touchedSec = sec
}

/** Per-slot sums over the `windowS` seconds ending at `sec`. */
export function ringSum(r: CountRing, windowS: number, sec: number, slots: number): number[] {
  ringCatchUp(r, sec, slots)
  const out = new Array<number>(slots).fill(0)
  for (let i = 0; i < windowS; i++) {
    const base = (((sec - i) % RING_SECONDS) + RING_SECONDS) % RING_SECONDS
    for (let k = 0; k < slots; k++) out[k] += r.counts[base * slots + k]
  }
  return out
}

/** `slot` over the window ending at `sec`, folded into `points` buckets (oldest first). */
export function ringSeries(
  r: CountRing,
  windowS: number,
  sec: number,
  points: number,
  slots: number,
  slot = 0
): number[] {
  const per = windowS / points
  const out = new Array<number>(points).fill(0)
  for (let i = 0; i < windowS; i++) {
    const s = sec - windowS + 1 + i
    const base = ((s % RING_SECONDS) + RING_SECONDS) % RING_SECONDS
    out[Math.min(points - 1, Math.floor(i / per))] += r.counts[base * slots + slot]
  }
  return out
}

/** Every slot of one second. */
export function ringSecond(r: CountRing, sec: number, slots: number): number[] {
  ringCatchUp(r, sec, slots)
  const base = (sec % RING_SECONDS) * slots
  return Array.from(r.counts.subarray(base, base + slots))
}

/** Per-minute counts stamped with the minute they belong to, so a wrapped slot never reads stale. */
export interface MinuteSeries {
  c: Uint16Array
  m: Int32Array
}

/**
 * Count `n` for `key` in the minute of `sec`. At `cap` keys a key idle for the whole window is
 * evicted; if none is, the count lands on `__other__`.
 */
export function bumpMinute(
  map: Map<string, MinuteSeries>,
  key: string,
  sec: number,
  n = 1,
  cap = TOP_KEYS_CAP
): void {
  let arr = map.get(key)
  if (!arr) {
    if (map.size >= cap) {
      const cur = Math.floor(sec / 60)
      for (const [k, v] of map) {
        let newest = -1
        for (let i = 0; i < MINUTE_BUCKETS; i++) if (v.m[i] > newest) newest = v.m[i]
        if (k !== OTHER_KEY && newest < cur - (MINUTE_BUCKETS - 1)) {
          map.delete(k)
          break
        }
      }
    }
    if (map.size >= cap) {
      key = OTHER_KEY
      arr = map.get(key)
    }
    if (!arr) {
      arr = { c: new Uint16Array(MINUTE_BUCKETS), m: new Int32Array(MINUTE_BUCKETS).fill(-1) }
      map.set(key, arr)
    }
  }
  const mn = Math.floor(sec / 60)
  const i = mn % MINUTE_BUCKETS
  if (arr.m[i] !== mn) {
    arr.m[i] = mn
    arr.c[i] = 0
  }
  if (n === 1) {
    if (arr.c[i] < 65535) arr.c[i]++
  } else if (n > 0) arr.c[i] = Math.min(65535, arr.c[i] + n)
}

/** Sum of a key's minutes covering the `windowS` seconds ending at `sec` (+ the minute before). */
export function sumMinute(arr: MinuteSeries, windowS: number, sec: number): number {
  const minutes = Math.min(MINUTE_BUCKETS, Math.ceil(windowS / 60) + 1)
  const cur = Math.floor(sec / 60)
  let s = 0
  for (let k = 0; k < minutes; k++) {
    const mn = cur - k
    const i = ((mn % MINUTE_BUCKETS) + MINUTE_BUCKETS) % MINUTE_BUCKETS
    if (arr.m[i] === mn) s += arr.c[i]
  }
  return s
}

/** The `n` busiest keys in the window, busiest first; zero rows are left out. */
export function topMinutes(
  map: Map<string, MinuteSeries>,
  windowS: number,
  sec: number,
  n: number
): Array<[string, number]> {
  const rows: Array<[string, number]> = []
  for (const [k, arr] of map) {
    const v = sumMinute(arr, windowS, sec)
    if (v > 0) rows.push([k, v])
  }
  return rows.sort((a, b) => b[1] - a[1]).slice(0, n)
}

/** The newest minute a series holds (-1 when empty). */
function newestMinute(arr: MinuteSeries): number {
  let newest = -1
  for (let i = 0; i < MINUTE_BUCKETS; i++) if (arr.m[i] > newest) newest = arr.m[i]
  return newest
}

/**
 * Keyed per-minute counts over the 15-minute window, at most `cap` keys (then `__other__`).
 * For taps: e.g. per-entity × caller counts, per-route codes.
 */
export class MinuteCounter {
  private map = new Map<string, MinuteSeries>()
  constructor(private cap = TOP_KEYS_CAP) {}
  bump(key: string, sec: number, n = 1): void {
    bumpMinute(this.map, key, sec, n, this.cap)
  }
  sum(key: string, windowS: number, sec: number): number {
    const arr = this.map.get(key)
    return arr ? sumMinute(arr, windowS, sec) : 0
  }
  top(windowS: number, sec: number, n = this.cap): Array<[string, number]> {
    return topMinutes(this.map, windowS, sec, n)
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
  /** Drop keys idle for the whole window. Returns how many went. */
  sweep(sec: number): number {
    const cur = Math.floor(sec / 60)
    let removed = 0
    for (const [k, v] of this.map) {
      if (newestMinute(v) < cur - (MINUTE_BUCKETS - 1)) {
        this.map.delete(k)
        removed++
      }
    }
    return removed
  }
}

/** A per-second ring of `slots` counters over RING_SECONDS, with catch-up zeroing. */
export class SecondRing implements CountRing {
  counts: Int32Array
  lastSec: number
  touchedSec: number
  constructor(
    readonly slots = 1,
    sec = 0
  ) {
    this.counts = new Int32Array(RING_SECONDS * slots)
    this.lastSec = sec
    this.touchedSec = sec
  }
  bump(sec: number, slot = 0, n = 1): void {
    ringBump(this, sec, slot, this.slots, n)
  }
  /** Per-slot sums over the window ending at `sec`. */
  sum(windowS: number, sec: number): number[] {
    return ringSum(this, windowS, sec, this.slots)
  }
  series(windowS: number, sec: number, points: number, slot = 0): number[] {
    ringCatchUp(this, sec, this.slots)
    return ringSeries(this, windowS, sec, points, this.slots, slot)
  }
  second(sec: number): number[] {
    return ringSecond(this, sec, this.slots)
  }
  /** Idle for the whole ring? */
  idle(sec: number): boolean {
    return sec - this.touchedSec >= RING_SECONDS
  }
}
