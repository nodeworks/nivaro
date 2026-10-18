// Traffic Map — long-lived connections, media, search and MCP: the figures the server returns,
// the react-query hooks that read them, and the module copies the side badges read between polls.
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useTrafficMap } from '../../context'
import { requestCanvasRepaint } from '../../registry/canvasLayers'
import { useFrozenSnapshotId } from '../snapshots'

// ── #2155 streams ────────────────────────────────────────────────────────────
export interface StreamRow {
  kind: string
  label: string
  hint: string
  open: number
  peak: number
  opened: number
  closed: number
  events: number
  bytes: number
}
export interface StreamsData {
  window_s: number
  streams: StreamRow[]
}
/** Stream sources are `stream:<kind>`. */
export const isStreamSource = (id: string): boolean => id.startsWith('stream:')
export const MCP_SOURCE = 'mcp:clients'
export const SOCKET_SOURCE = 'socket:browsers'
export const MEDIA_NODE = 'media'
export const SEARCH_NODE = 'search'

// ── #2159 rooms ──────────────────────────────────────────────────────────────
export interface RoomRow {
  room: string
  kind: string
  cls: string
  hidden: boolean
  rooms: number
  members: number
  broadcasts_pm: number
  deliveries_pm: number
  bytes_pm: number
}
export interface RoomsData {
  window_s: number
  scope: string
  rows: RoomRow[]
  total_rooms: number
}
export interface RoomDetail {
  room: string
  kind: string
  members: Array<{ id: string; name: string; sockets: number }>
  members_total: number
  recent: Array<{ at: string; event: string; bytes: number; n: number }>
}

// ── #2263 failures ───────────────────────────────────────────────────────────
export interface FailureBucket {
  key: string
  n: number
  people: number
}
export interface FailuresData {
  since_h: number
  total: number
  failed: number
  downgraded: number
  by_network: FailureBucket[]
  by_browser: FailureBucket[]
  by_app: FailureBucket[]
  groups: Array<{
    kind: 'failed' | 'downgraded'
    app: string
    browser: string
    network: string
    transport: string
    reason: string
    n: number
    people: number
    last_at: string
  }>
  polling_now: {
    total: number
    sockets: number
    by_network: FailureBucket[]
    by_browser: FailureBucket[]
    by_app: FailureBucket[]
  }
}

// ── #2266 adapter lag ────────────────────────────────────────────────────────
export type LagLevel = 'idle' | 'ok' | 'warn' | 'error'
export interface AdapterLagData {
  level: LagLevel
  warn_ms: number
  last_ms: number | null
  last_at: string | null
  total: number
  minutes: Array<{ min: number; n: number; avg_ms: number; max_ms: number }>
  recent_avg_ms: number | null
  recent_max_ms: number | null
  baseline_avg_ms: number | null
  growing: boolean
}

// ── #2269 media ──────────────────────────────────────────────────────────────
export interface MediaRow {
  requests: number
  bytes: number
  failed: number
  avg_ms: number | null
  active: number
}
export interface MediaData {
  window_s: number
  video: MediaRow
  replay: MediaRow
}

// ── #2270 search ─────────────────────────────────────────────────────────────
export interface SearchData {
  window_s: number
  total: { requests: number; failed: number; db_ms: number; avg_db_ms: number | null }
  by_kind: Array<{
    kind: string
    label: string
    requests: number
    failed: number
    db_ms: number
    avg_db_ms: number | null
    avg_ms: number | null
  }>
  slowest: Array<{
    at: string
    kind: string
    label: string
    route: string
    ms: number
    db_ms: number
    stmt_ms: number | null
    sql: string | null
    caller: string
    status: number
  }>
}

// ── #2211 MCP ────────────────────────────────────────────────────────────────
export interface McpData {
  window_s: number
  calls: number
  errors: number
  last_at: string | null
  tools: Array<{ tool: string; calls: number; errors: number }>
  keys: Array<{ caller: string; name: string; calls: number; errors: number }>
  codes: Array<{ code: string; n: number }>
  recent_errors: Array<{
    at: string
    tool: string
    status: number
    code: string | null
    caller: string
    name: string
  }>
}

// ── module copies (side badges read these between polls) ────────────────────
export interface BadgeFigures {
  lag: AdapterLagData | null
  media: MediaData | null
  mcp: McpData | null
}
let figures: BadgeFigures = { lag: null, media: null, mcp: null }
export const badgeFigures = (): BadgeFigures => figures
export function setBadgeFigures(v: BadgeFigures): void {
  figures = v
  requestCanvasRepaint()
}

const POLL_MS = 15_000

function useLive(): { win: number; enabled: boolean; interval: number | false } {
  const { win, paused, ready } = useTrafficMap()
  const frozen = useFrozenSnapshotId()
  return { win, enabled: ready && !frozen, interval: paused ? false : POLL_MS }
}

function useFigures<T>(path: string, key: string, active: boolean, windowed = true) {
  const { win, enabled, interval } = useLive()
  return useQuery({
    queryKey: ['traffic-map', 'realtime', key, windowed ? win : 0],
    queryFn: async () =>
      (await api.get(`/traffic-map/realtime/${path}${windowed ? `?window=${win}` : ''}`)).data
        .data as T,
    enabled: enabled && active,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    staleTime: POLL_MS - 1000
  })
}

export const useStreams = (active: boolean) => useFigures<StreamsData>('streams', 'streams', active)
export const useRooms = (active: boolean) => useFigures<RoomsData>('rooms', 'rooms', active)
export const useAdapterLag = (active: boolean) =>
  useFigures<AdapterLagData>('adapter-lag', 'lag', active, false)
export const useMedia = (active: boolean) => useFigures<MediaData>('media', 'media', active)
export const useSearch = (active: boolean) => useFigures<SearchData>('search', 'search', active)
export const useMcp = (active: boolean) => useFigures<McpData>('mcp', 'mcp', active)

export function useFailures(active: boolean) {
  const { enabled, interval } = useLive()
  return useQuery({
    queryKey: ['traffic-map', 'realtime', 'failures'],
    queryFn: async () =>
      (await api.get('/traffic-map/realtime/failures?hours=24')).data.data as FailuresData,
    enabled: enabled && active,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    staleTime: POLL_MS - 1000
  })
}

export function useRoomDetail(name: string | null) {
  return useQuery({
    queryKey: ['traffic-map', 'realtime', 'room', name],
    queryFn: async () =>
      (await api.get('/traffic-map/realtime/room', { params: { name } })).data.data as RoomDetail,
    enabled: !!name,
    staleTime: 5_000,
    refetchInterval: 10_000,
    retry: false
  })
}

// ── pure helpers (tested) ────────────────────────────────────────────────────
/** "340 ms", "1.2 s" — lag keeps its sub-second precision (fmtMs shows 0 as a dash). */
export function lagText(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  if (ms < 1) return '0 ms'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`
}

/** The badge the Sockets node wears when relayed events arrive late (nothing when fine). */
export function lagBadge(
  lag: AdapterLagData | null
): { text: string; tone: 'warn' | 'error' } | null {
  if (!lag || (lag.level !== 'warn' && lag.level !== 'error')) return null
  const text =
    lag.growing && lag.level === 'warn' ? 'lag growing' : `lag ${lagText(lag.recent_avg_ms)}`
  return { text, tone: lag.level === 'error' ? 'error' : 'warn' }
}

/** Events per second from a window total. */
export function perSecond(total: number, windowS: number): number {
  return windowS > 0 ? total / windowS : 0
}

/** Bytes per second as "12 KB/s". */
export function bandwidthText(bytes: number, windowS: number): string {
  const bps = perSecond(bytes, windowS)
  if (!Number.isFinite(bps) || bps <= 0) return '—'
  if (bps < 1024) return `${Math.round(bps)} B/s`
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(bps < 10 * 1024 ? 1 : 0)} KB/s`
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`
}
