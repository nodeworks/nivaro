export type Lane =
  | 'items'
  | 'widgets'
  | 'pages'
  | 'queries'
  | 'graphql'
  | 'inbound'
  | 'files'
  | 'extension'
  | 'system'
  | 'socket'
  | 'other'
export type Kind = 'read' | 'create' | 'update' | 'delete' | 'error'
export const KIND_ORDER: Kind[] = ['read', 'create', 'update', 'delete', 'error']
/** Slot order inside every counts array on the wire. */
export const SLOT = { req: 0, read: 1, create: 2, update: 3, delete: 4, error: 5 } as const
export const LANE_ORDER: Lane[] = [
  'items',
  'widgets',
  'pages',
  'queries',
  'graphql',
  'inbound',
  'files',
  'extension',
  'system',
  'socket',
  'other'
]
export const LANE_LABEL: Record<Lane, string> = {
  items: 'Items',
  widgets: 'Widgets',
  pages: 'Pages',
  queries: 'Custom queries',
  graphql: 'GraphQL',
  inbound: 'Inbound',
  files: 'Files',
  extension: 'Extensions',
  system: 'System',
  socket: 'Sockets',
  other: 'Other'
}

export interface TrafficEventWire {
  t: number
  lane: Lane
  entity: string
  kind: Kind
  caller: string
  route: string
  status?: number
  ms?: number
  record?: string
  fields?: string[]
  code?: string | null
  via?: string
  /** Integration event chain of the request / write (opens the event path sheet). */
  chain?: string
  /** Short neutral labels a server tap adds (ticker chips). */
  tags?: string[]
  /** Tap-specific fields. */
  extra?: Record<string, unknown>
}
export interface TrafficFrame {
  v: 1
  at: string
  instance: string
  node_scope: string
  frame: number
  window_s: 1
  entities: Record<string, number[]> // [req, read, create, update, delete, error, p95]
  callers: Record<string, number[]> // [req, error]
  down: Record<string, number[]> // [req, error, p95]
  /** Names for down nodes in this frame that are not plain ids (partners, declared nodes). */
  down_labels?: Record<string, string>
  edges_in: Record<string, number>
  edges_out: Record<string, number>
  events: TrafficEventWire[]
  events_dropped?: number
  sockets: number
  journal_seq: number | null
  /** Server tap figures for this second, by tap id. */
  ext?: Record<string, unknown>
}
export interface RecentError {
  at: string
  status: number
  code: string | null
  route: string
  caller: string
  record: string | null
}
export interface RecentWrite {
  at: string
  action: 'create' | 'update' | 'delete'
  record: string
  fields: string[]
  caller: string
  via: string
}
export interface SnapshotEntity {
  key: string
  lane: Lane
  entity: string
  label: string
  system: boolean
  req: number
  read: number
  create: number
  update: number
  delete: number
  error: number
  p50: number
  p95: number
  series: number[]
  routes: Array<{ route: string; n: number }>
  callers: Array<{ key: string; n: number }>
  down: Record<string, number>
  recent_errors: RecentError[]
  recent_writes: RecentWrite[]
  /** Server tap figures for this entity, by tap id. */
  ext?: Record<string, unknown>
}
export interface TrafficSnapshot {
  instance: string
  node_scope: string
  at: string
  window_s: number
  uptime_s: number
  frame: number
  lanes: Array<{ id: Lane; label: string; route_hint: string }>
  entities: SnapshotEntity[]
  callers: Array<{ key: string; req: number; error: number }>
  down: Array<{
    id: string
    label: string
    /** 'db' | 'cache' | 'storage' | 'partner', or a server noteDown kind ('service', …). */
    kind: string
    req: number
    error: number
    p95: number
  }>
  totals: {
    req: number
    read: number
    create: number
    update: number
    delete: number
    error: number
    p50: number
    p95: number
    outbound_req: number
    outbound_error: number
  }
  sockets: { count: number; users: number }
  journal_seq: number | null
  /** Non-request sources (cron jobs, the import worker, sockets) with traffic in the window. */
  sources?: Array<{ id: string; label: string; kind: string; req: number; error: number }>
  /** Server tap figures, by tap id. */
  ext?: Record<string, unknown>
}
export type TrafficSource = NonNullable<TrafficSnapshot['sources']>[number]
export interface TrafficCatalog {
  collections: Record<string, { label: string; system: boolean }>
  widgets: Record<string, string>
  pages: Record<string, string>
  queries: Record<string, string>
  inbound: Record<string, string>
  extensions: Record<string, string>
  partners: Record<string, string>
  callers: Record<
    string,
    { label: string; kind: 'key' | 'person' | 'machine' | 'cron' | 'anon' | 'source' }
  >
  down: Record<string, string>
}
export interface EntityHistory {
  key: string
  hours: number
  bucket_s: number
  series: Array<{ t: string; req: number; error: number; p95: number }>
  totals: {
    req: number
    read: number
    write_requests: number
    /** Rehearsed writes (dry runs, flow tests), kept out of write_requests (#1139). */
    rehearsal?: number
    error: number
    p50: number
    p95: number
  }
  status_codes: Record<string, number>
  top_routes: Array<{ route: string; n: number }>
  top_callers: Array<{ key: string; n: number }>
  issues: Array<{
    id: number
    title: string
    severity: string
    status: string
    occurrence_count: number
    last_seen_at: string | null
  }>
  slow_traces: Array<{ id: string; route: string; total_ms: number; ts: string }>
  truncated: boolean
}
export interface DownHistory {
  key: string
  hours: number
  bucket_s?: number
  series: Array<{ t: string; req: number; error: number; p95: number }>
  totals?: { req: number; error: number }
  status_codes?: Record<string, number>
  top_paths?: Array<{ path: string; n: number }>
  note?: string
  truncated?: boolean
}
export interface Filters {
  types: Set<Lane>
  kinds: Set<Kind>
  caller: string
  win: 60 | 300 | 900
  /** #1133: a group of callers (a caller kind the natural-language filter picked); `caller` wins. */
  callers?: string[]
  /** #1154: the whole map scoped to one workspace (upper-case id). */
  workspace?: string
}
export type Selection =
  /** `caller` (#1095): the inspector narrows the entity to that caller's traffic. */
  | { kind: 'entity'; id: string; caller?: string }
  | { kind: 'lane'; id: Lane }
  | { kind: 'caller'; id: string }
  | { kind: 'down'; id: string }
