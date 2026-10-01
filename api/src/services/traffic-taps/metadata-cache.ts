// api/src/services/traffic-taps/metadata-cache.ts
/**
 * #1176 — the driver-level configuration cache (db/metadata-query-cache.ts) on the map's database
 * node: how many configuration reads it answered from memory over the window, how often a write
 * cleared it, and a per-30-second hit-rate series. Its sparkline carries the change markers, so a
 * latency bump right after a configuration edit (the cache emptied, every read went to the
 * database) explains itself; the config-epoch marker now names the table the edit touched
 * (change-markers.ts).
 *
 * The cache's counters are process-wide and only ever grow, so the tap samples them every
 * SAMPLE_S seconds (memory only, never in cloud mode — that process has no driver cache) and
 * reads windows as differences between samples.
 *
 * frame (every 5 s): { hit_rate, entries } over the last minute.
 * snapshot: MetadataCacheFigures for the window.
 */
import { configEpochState } from '../../db/config-epoch.js'
import { metadataQueryCacheStats } from '../../db/metadata-query-cache.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'

export const METADATA_CACHE_TAP = 'metadata-cache'
export const SAMPLE_S = 10
/** Samples kept: SAMPLE_S × 120 = 20 minutes, past the map's longest window. */
const KEEP = 120

export interface CacheSample {
  sec: number
  hits: number
  misses: number
  shared: number
  busts: number
  entries: number
}
interface State {
  samples: CacheSample[]
}
const state = (): State => tapState<State>(METADATA_CACHE_TAP, () => ({ samples: [] }))

export interface MetadataCacheFigures {
  window_s: number
  enabled: boolean
  hits: number
  misses: number
  shared: number
  /** Times a configuration write emptied the cache. */
  clears: number
  /** hits / (hits + misses); null without reads. */
  hit_rate: number | null
  entries: number
  ttl_ms: number
  /** Hit rate per 30 s bucket over the window (null = no reads in the bucket). */
  series: Array<number | null>
  epoch: { seen: number | null; last_moved_at: string | null; last_statement: string | null }
}

/** Differences between the samples covering a window, bucketed. Pure. */
export function figuresFrom(
  samples: CacheSample[],
  windowS: number,
  sec: number,
  bucketS = 30
): Omit<MetadataCacheFigures, 'enabled' | 'ttl_ms' | 'epoch' | 'window_s'> {
  const from = sec - windowS
  const inWin = samples.filter((s) => s.sec >= from)
  const before = [...samples].reverse().find((s) => s.sec < from) ?? inWin[0]
  const last = inWin[inWin.length - 1] ?? samples[samples.length - 1]
  const d = (k: 'hits' | 'misses' | 'shared' | 'busts') =>
    last && before ? Math.max(0, last[k] - before[k]) : 0
  const hits = d('hits')
  const misses = d('misses')
  const buckets = Math.max(1, Math.ceil(windowS / bucketS))
  const series: Array<number | null> = []
  for (let b = 0; b < buckets; b++) {
    const lo = from + b * bucketS
    const hi = lo + bucketS
    const start = [...samples].reverse().find((s) => s.sec <= lo)
    const end = [...samples].reverse().find((s) => s.sec <= hi)
    if (!start || !end || end.sec <= start.sec) {
      series.push(null)
      continue
    }
    const h = Math.max(0, end.hits - start.hits)
    const m = Math.max(0, end.misses - start.misses)
    series.push(h + m > 0 ? Math.round((h / (h + m)) * 1000) / 1000 : null)
  }
  return {
    hits,
    misses,
    shared: d('shared'),
    clears: d('busts'),
    hit_rate: hits + misses > 0 ? Math.round((hits / (hits + misses)) * 1000) / 1000 : null,
    entries: last?.entries ?? 0,
    series
  }
}

function sample(sec: number): void {
  const s = metadataQueryCacheStats() as Record<string, number | boolean>
  const st = state()
  const prev = st.samples[st.samples.length - 1]
  if (prev && prev.sec === sec) return
  st.samples.push({
    sec,
    hits: Number(s.hits) || 0,
    misses: Number(s.misses) || 0,
    shared: Number(s.shared) || 0,
    busts: Number(s.busts) || 0,
    entries: Number(s.entries) || 0
  })
  if (st.samples.length > KEEP) st.samples.shift()
}

let timer: NodeJS.Timeout | null = null
/** Start sampling (idempotent; never in cloud mode). */
export function startMetadataCacheSampling(): void {
  if (timer || process.env.CLOUD_META_DB_URL) return
  const tick = () => {
    try {
      sample(Math.floor(Date.now() / 1000))
    } catch {
      /* never */
    }
  }
  tick()
  timer = setInterval(tick, SAMPLE_S * 1000)
  timer.unref?.()
}
export function stopMetadataCacheSampling(): void {
  if (timer) clearInterval(timer)
  timer = null
}

export function metadataCacheFigures(windowS: number, sec: number): MetadataCacheFigures {
  const stats = metadataQueryCacheStats() as Record<string, number | boolean>
  const ep = configEpochState()
  return {
    window_s: windowS,
    enabled: stats.enabled !== false,
    ttl_ms: Number(stats.ttl_ms) || 0,
    ...figuresFrom(state().samples, windowS, sec),
    epoch: { seen: ep.seen, last_moved_at: ep.last_moved_at, last_statement: ep.last_statement }
  }
}

registerTrafficTap({
  id: METADATA_CACHE_TAP,
  frame(sec) {
    if (process.env.CLOUD_META_DB_URL || sec % 5 !== 0) return undefined
    const f = figuresFrom(state().samples, 60, sec)
    return { hit_rate: f.hit_rate, entries: f.entries, clears: f.clears }
  },
  snapshot(windowS, sec) {
    if (process.env.CLOUD_META_DB_URL) return undefined
    return metadataCacheFigures(windowS, sec)
  }
} satisfies TrafficTap)
