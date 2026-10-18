import { useSyncExternalStore } from 'react'

/**
 * Normal bands behind sparklines (#2145): the baselines feature sets the source; a sparkline of
 * one node's requests asks it for that node's normal range (requests per minute) and gets it back
 * in the series' own unit (requests per point). Null = no band (none learned, or no source).
 */
export type SparkBandNode =
  | { kind: 'entity'; id: string; caller?: string }
  | { kind: 'caller' | 'down'; id: string }
  | { kind: 'total' }
export interface SparkBandSource {
  /** Normal requests per minute [lo, hi] for a node, or null. */
  get(node: SparkBandNode): { lo: number; hi: number } | null
  subscribe(fn: () => void): () => void
  version(): number
}

let source: SparkBandSource | null = null
export function setSparkBandSource(s: SparkBandSource | null): void {
  source = s
}

const noop = () => () => {}
const zero = () => 0

/** The band for a series of `points` points over `win` seconds, in requests per point. */
export function useSparkBand(
  node: SparkBandNode | null,
  win: number,
  points: number
): { lo: number; hi: number } | null {
  useSyncExternalStore(source ? (fn) => source?.subscribe(fn) ?? (() => {}) : noop, () =>
    source ? source.version() : zero()
  )
  if (!source || !node || points <= 0 || win <= 0) return null
  try {
    const b = source.get(node)
    if (!b) return null
    const perPoint = win / points / 60
    return { lo: b.lo * perPoint, hi: b.hi * perPoint }
  } catch {
    return null
  }
}
