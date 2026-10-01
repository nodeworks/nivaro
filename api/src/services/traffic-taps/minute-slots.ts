// api/src/services/traffic-taps/minute-slots.ts
/**
 * Per-minute sums of a fixed number of float slots over the Traffic Map's 15-minute window —
 * the measurement taps' counter (MinuteCounter counts integers; these hold milliseconds). One
 * entity costs MINUTE_BUCKETS × slots doubles, so a full map stays in the low hundreds of KB.
 */
import { MINUTE_BUCKETS } from '../traffic-ring.js'

export class MinuteSlots {
  private v: Float64Array
  private m: Int32Array
  constructor(readonly slots: number) {
    this.v = new Float64Array(MINUTE_BUCKETS * slots)
    this.m = new Int32Array(MINUTE_BUCKETS).fill(-1)
  }

  /** Add `n` to `slot` in the minute of `sec`. */
  add(sec: number, slot: number, n: number): void {
    if (!Number.isFinite(n) || n === 0 || slot < 0 || slot >= this.slots) return
    const mn = Math.floor(sec / 60)
    const i = ((mn % MINUTE_BUCKETS) + MINUTE_BUCKETS) % MINUTE_BUCKETS
    if (this.m[i] !== mn) {
      if (this.m[i] > mn) return // older than the bucket holds now
      this.m[i] = mn
      this.v.fill(0, i * this.slots, (i + 1) * this.slots)
    }
    this.v[i * this.slots + slot] += n
  }

  /** Per-slot sums over the minutes covering the `windowS` seconds ending at `sec` (+1 minute,
   *  the same rule as the map's own per-minute counters). */
  sum(windowS: number, sec: number): number[] {
    const out = new Array<number>(this.slots).fill(0)
    const minutes = Math.min(MINUTE_BUCKETS, Math.ceil(windowS / 60) + 1)
    const cur = Math.floor(sec / 60)
    for (let k = 0; k < minutes; k++) {
      const mn = cur - k
      const i = ((mn % MINUTE_BUCKETS) + MINUTE_BUCKETS) % MINUTE_BUCKETS
      if (this.m[i] !== mn) continue
      const base = i * this.slots
      for (let s = 0; s < this.slots; s++) out[s] += this.v[base + s]
    }
    return out
  }

  /** The newest minute holding anything (-1 when empty). */
  newestMinute(): number {
    let newest = -1
    for (let i = 0; i < MINUTE_BUCKETS; i++) if (this.m[i] > newest) newest = this.m[i]
    return newest
  }

  /** Idle for the whole window at `sec`? */
  idle(sec: number): boolean {
    return this.newestMinute() < Math.floor(sec / 60) - (MINUTE_BUCKETS - 1)
  }
}

/** Keep a Map bounded: drop entries `idle` says are idle; past `cap` refuse new keys (null). */
export function boundedGet<V>(
  map: Map<string, V>,
  key: string,
  cap: number,
  make: () => V
): V | null {
  let v = map.get(key)
  if (v) return v
  if (map.size >= cap) return null
  v = make()
  map.set(key, v)
  return v
}
