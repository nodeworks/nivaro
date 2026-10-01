import { useSyncExternalStore } from 'react'

/**
 * Change markers on sparklines (#1093): the change-markers feature sets the PRIMARY source;
 * other features add theirs with `addSparkMarkerSource` (#1171 deadlocks). Every Sparkline given a
 * `range` asks every source for the markers inside that range (synchronously, from each source's
 * cache) and re-renders when any source says its data moved.
 */
export interface SparkMarker {
  kind: 'boot' | 'deploy' | 'config' | 'snapshot' | 'maintenance' | 'deadlock'
  /** Epoch ms. */
  at: number
  /** Epoch ms (spans: maintenance windows). */
  until?: number
  label: string
}
export interface SparkMarkerSource {
  /** Markers between `from` and `to` (epoch ms) from the cache; may start a background fetch. */
  get(from: number, to: number): SparkMarker[]
  subscribe(fn: () => void): () => void
  version(): number
}

let primary: SparkMarkerSource | null = null
const extra = new Map<string, SparkMarkerSource>()
const NONE: SparkMarker[] = []

export function setSparkMarkerSource(s: SparkMarkerSource | null): void {
  primary = s
}

/** Add (or replace, by id) another marker source beside the primary one. */
export function addSparkMarkerSource(id: string, s: SparkMarkerSource | null): void {
  if (s) extra.set(id, s)
  else extra.delete(id)
}

function sources(): SparkMarkerSource[] {
  return primary ? [primary, ...extra.values()] : [...extra.values()]
}
function subscribeAll(fn: () => void): () => void {
  const offs = sources().map((s) => s.subscribe(fn))
  return () => {
    for (const off of offs) off()
  }
}
/** One number that moves when any source's data moves (each source's version only grows). */
function versionAll(): number {
  let v = 0
  for (const s of sources()) v += s.version()
  return v
}

/** Markers in a range from every source, oldest first (empty without a source or a range). */
export function useSparkMarkers(range: { from: number; to: number } | undefined): SparkMarker[] {
  useSyncExternalStore(subscribeAll, versionAll)
  const list = sources()
  if (!list.length || !range || !(range.to > range.from)) return NONE
  const out: SparkMarker[] = []
  for (const s of list) {
    try {
      out.push(...s.get(range.from, range.to))
    } catch {
      /* a broken source adds nothing */
    }
  }
  if (!out.length) return NONE
  return list.length > 1 ? out.sort((a, b) => a.at - b.at) : out
}
