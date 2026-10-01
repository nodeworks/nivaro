// Topology (Traffic Map group C) — the live topology figures and the module stores the canvas
// layers read. The page snapshot is only re-read on reconnect or a window change, so the topology
// taps' window figures come from GET /traffic-map/topology, polled every 5 s while the page is
// live (paused = no polling). One react-query key: the poller, the inspector panels and the
// canvas layers all read the same answer.
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

export interface SourceFigures {
  label: string
  kind: string
  runs: number
  errors: number
  p95_ms: number
  last: { at: number; ms: number; ok: boolean } | null
}
export interface ImportRun {
  run_id: number
  key: string
  label: string | null
  started_at: number
  rows: number | null
  phase: string
  rows_per_s?: number | null
  ok?: boolean
  finished_at?: number
}
export interface PoolFigures {
  window_s: number
  acquires: number
  wait_p50_ms: number
  wait_p95_ms: number
  wait_max_ms: number
  saturated_pct: number
  peak_used: number
  peak_pending: number
  max: number
  level: 'ok' | 'warn' | 'error'
}
export interface TopologyData {
  sources?: {
    sources: Record<string, SourceFigures>
    /** `<source>><down>` → calls in the window */
    sd: Record<string, number>
    triggers: Record<string, Array<{ key: string; n: number }>>
    import: { current: ImportRun | null; last: ImportRun | null }
  }
  partners?: {
    buckets: number[]
    downs: Record<string, { classes: Record<string, number>; hist: number[] }>
  }
  pool?: PoolFigures
  redis?: {
    commands: number
    cps: number
    families: Array<{ family: string; n: number }>
    top_commands: Array<{ name: string; n: number }>
  }
  channels?: Record<string, Record<string, number>>
  ai?: {
    providers: Record<
      string,
      {
        calls?: number
        errors?: number
        in?: number
        out?: number
        cached?: number
        cost?: number
        models?: Array<{ model: string; n: number }>
      }
    >
    fallbacks: Array<{ from: string; to: string; n: number }>
    fallbacks_since_boot: number
  }
  webhooks?: {
    slow_ms: number
    webhooks: Record<string, { failed: number; slow: number; codes: Record<string, number> }>
  }
  nodes?: Array<{ id: string; extension: string; label: string }>
}

export const TOPOLOGY_POLL_MS = 5000

let current: { win: number; data: TopologyData } | null = null
/** The newest topology answer (for canvas layers, which cannot use hooks). */
export function topologyNow(): TopologyData | null {
  return current?.data ?? null
}
/** Window of the newest answer. */
export function topologyWin(): number {
  return current?.win ?? 60
}
export function setTopology(win: number, data: TopologyData | null): void {
  current = data ? { win, data } : null
}

export function topologyKey(win: number) {
  return ['traffic-map', 'topology', win] as const
}

export function useTopology(win: number, paused: boolean) {
  return useQuery({
    queryKey: topologyKey(win),
    queryFn: async () => {
      const res = await api.get(`/traffic-map/topology?window=${win}`)
      return (res.data.data ?? {}) as TopologyData
    },
    refetchInterval: paused ? false : TOPOLOGY_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: TOPOLOGY_POLL_MS - 500
  })
}

// ── partner dependency overlay (#1103) ──────────────────────────────────────
export interface DependencyCollection {
  collection: string
  calls: number
  read_all: boolean
  writes: boolean
  read: Array<{ field: string; calls: number }>
  written: Array<{ field: string; calls: number }>
}
export interface DependencyOverlay {
  caller: string
  label: string
  collections: Map<string, DependencyCollection>
}
let overlay: DependencyOverlay | null = null
const overlayListeners = new Set<() => void>()
export function dependencyOverlay(): DependencyOverlay | null {
  return overlay
}
export function setDependencyOverlay(next: DependencyOverlay | null): void {
  overlay = next
  for (const l of overlayListeners) l()
}
export function subscribeDependencyOverlay(fn: () => void): () => void {
  overlayListeners.add(fn)
  return () => {
    overlayListeners.delete(fn)
  }
}

/** The partner-dependency map's caller key for a Traffic Map caller (`k12` → `key:12`). */
export function dependencyKeyOf(caller: string): string | null {
  if (/^k\d+$/.test(caller)) return `key:${caller.slice(1)}`
  if (/^u[0-9A-Fa-f-]{36}$/.test(caller)) return `user:${caller.slice(1).toUpperCase()}`
  return null
}
