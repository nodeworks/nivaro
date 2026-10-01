import { useSyncExternalStore } from 'react'

/**
 * Change markers on sparklines (#1093): a feature registers ONE source; every Sparkline given a
 * `range` asks it for the markers inside that range (synchronously, from the source's cache)
 * and re-renders when the source says its data moved.
 */
export interface SparkMarker {
  kind: 'boot' | 'deploy' | 'config' | 'snapshot' | 'maintenance'
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

let source: SparkMarkerSource | null = null
const NONE: SparkMarker[] = []
const noop = () => () => {}

export function setSparkMarkerSource(s: SparkMarkerSource | null): void {
  source = s
}

/** Markers in a range (empty without a source or a range). */
export function useSparkMarkers(range: { from: number; to: number } | undefined): SparkMarker[] {
  const s = source
  useSyncExternalStore(s ? s.subscribe : noop, s ? s.version : () => 0)
  if (!s || !range || !(range.to > range.from)) return NONE
  try {
    return s.get(range.from, range.to)
  } catch {
    return NONE
  }
}
