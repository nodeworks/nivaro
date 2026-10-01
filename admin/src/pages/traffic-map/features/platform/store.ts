// Traffic Map round 4, platform group — the figures the server routes return, the react-query
// hooks that read them (one key each, shared by pollers, panels and canvas layers) and the module
// copies the canvas layers / node providers read synchronously between polls.
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useTrafficMap } from '../../context'
import { requestCanvasRepaint } from '../../registry/canvasLayers'
import { useFrozenSnapshotId } from '../snapshots'

// ── #1173 ownership ──────────────────────────────────────────────────────────
export const CORE = 'core'
export interface NodeOwnership {
  ms: Record<string, number>
  n: Record<string, number>
  total_ms: number
}
export interface OwnershipData {
  window_s: number
  nodes: Record<string, NodeOwnership>
  extensions: string[]
}

// ── #1175 queue cache ────────────────────────────────────────────────────────
export interface QueueCacheRow {
  id: string
  name: string
  materialized: boolean
  rows: number | null
  syncs: number
  sync_ms: number
  avg_ms: number | null
  max_ms: number | null
  failed: number
  collections: string[]
  last_sync_at: number | null
  backfill: {
    runs: number
    last_status: string | null
    last_started_at: string | null
    last_duration_ms: number | null
    running: boolean
  }
  since_rebuild_s: number | null
}
export interface QueueCacheData {
  window_s: number
  queues: QueueCacheRow[]
  lookups: Array<{ collection: string; writes: number; ms: number; hits: number }>
}
/** The down node the queue cache draws as. */
export const QUEUE_CACHE_NODE = 'queue-cache'

// ── #1184 dead letters ───────────────────────────────────────────────────────
export interface DeadLetterData {
  flow_runs: {
    count: number
    items: Array<{
      id: string
      flow: string
      flow_name: string | null
      trigger: string | null
      error: string | null
      failed_at: string | null
    }>
    by_flow: Record<string, number>
  }
  deliveries: {
    hours: number
    count: number
    items: Array<{
      id: number
      webhook: number
      webhook_name: string | null
      event: string
      status_code: number | null
      at: string | null
    }>
  }
}
/** The down node the dead letter sink draws as. */
export const DEAD_LETTER_NODE = 'dead-letters'

// ── module copies (canvas / providers read these between polls) ─────────────
let ownership: OwnershipData | null = null
let queueCache: QueueCacheData | null = null
let deadLetters: DeadLetterData | null = null
export const ownershipNow = () => ownership
export const queueCacheNow = () => queueCache
export const deadLettersNow = () => deadLetters
export function setOwnership(v: OwnershipData | null): void {
  ownership = v
  requestCanvasRepaint()
}
export function setQueueCache(v: QueueCacheData | null): void {
  queueCache = v
  requestCanvasRepaint()
}
export function setDeadLetters(v: DeadLetterData | null): void {
  deadLetters = v
  requestCanvasRepaint()
}

const POLL_MS = 15_000

function useLive(): { win: number; enabled: boolean; interval: number | false } {
  const { win, paused, ready } = useTrafficMap()
  const frozen = useFrozenSnapshotId()
  return { win, enabled: ready && !frozen, interval: paused ? false : POLL_MS }
}

export function useOwnership(active: boolean) {
  const { win, enabled, interval } = useLive()
  return useQuery({
    queryKey: ['traffic-map', 'ownership', win],
    queryFn: async () =>
      (await api.get(`/traffic-map/ownership?window=${win}`)).data.data as OwnershipData,
    enabled: enabled && active,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    staleTime: POLL_MS - 1000
  })
}

export function useQueueCache() {
  const { win, enabled, interval } = useLive()
  return useQuery({
    queryKey: ['traffic-map', 'queue-cache', win],
    queryFn: async () =>
      (await api.get(`/traffic-map/queue-cache?window=${win}`)).data.data as QueueCacheData,
    enabled,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    staleTime: POLL_MS - 1000
  })
}

export function useDeadLetters() {
  const { enabled, interval } = useLive()
  return useQuery({
    queryKey: ['traffic-map', 'dead-letters'],
    queryFn: async () => (await api.get('/traffic-map/dead-letters')).data.data as DeadLetterData,
    enabled,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    staleTime: POLL_MS - 1000
  })
}

// ── pure helpers (tested) ────────────────────────────────────────────────────
/** The extension a node id belongs to outright: an extension route, an extension cron job, or
 *  an extension-declared down node; null when the node is not owned outright. */
export function ownerOfNodeId(id: string): string | null {
  if (id.startsWith('extension/')) return id.slice('extension/'.length) || null
  const cron = /^cron:ext:([^:]+):/.exec(id)
  if (cron) return cron[1]
  if (id.startsWith('x:')) {
    const dot = id.indexOf('.')
    return dot > 2 ? id.slice(2, dot) : null
  }
  return null
}

/** Shares (0–1) per owner, biggest first; extensions outright-owned get 1. */
export function sharesOf(
  id: string,
  data: OwnershipData | null
): Array<{ owner: string; share: number; ms: number }> {
  const outright = ownerOfNodeId(id)
  const fig = data?.nodes[id]
  if (fig && fig.total_ms > 0) {
    return Object.entries(fig.ms)
      .map(([owner, ms]) => ({ owner, ms, share: ms / fig.total_ms }))
      .sort((a, b) => b.share - a.share)
  }
  if (outright) return [{ owner: outright, ms: 0, share: 1 }]
  return []
}

/** "3 h 12 m", "4 m", "38 s". */
export function ageText(s: number | null): string {
  if (s == null) return 'never'
  if (s < 60) return `${Math.round(s)} s`
  if (s < 3600) return `${Math.round(s / 60)} m`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} m`
  return `${Math.round(s / 86_400)} d`
}
