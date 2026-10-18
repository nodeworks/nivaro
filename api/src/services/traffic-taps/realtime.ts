// api/src/services/traffic-taps/realtime.ts
/**
 * Traffic Map tap `realtime` — the long-lived connections the request log never sees.
 *   #2155 streams: SSE streams (GraphQL, events, saved views, admin feed) and graphql-ws
 *         subscriptions, as sources feeding the Sockets lane — open now, events sent, bytes;
 *   #2159 rooms: socket rooms ranked by members and deliveries per minute, with each room's
 *         recent events (rooms that name people or private chat are only ever a kind + count);
 *   #2263 connection failures: failed / downgraded socket connections reported by the browsers,
 *         grouped by network, browser and app (plus sockets on long-polling right now);
 *   #2266 adapter lag: time from a journaled event being written on one replica to it being
 *         delivered by this one (Redis stream entry timestamp vs this replica's clock).
 *
 * Counter bumps only on the hot paths; memory is bounded everywhere. Self-hosted only: in cloud
 * mode (one process, many tenants) every note is a no-op, like the topology channel taps.
 */
import { getIo } from '../io-holder.js'
import { noteSource } from '../traffic-map.js'
import { registerTrafficTap, tapState } from '../traffic-taps.js'
import { boundedGet, MinuteSlots } from './minute-slots.js'

export const REALTIME_TAP = 'realtime'
const cloud = (): boolean => !!process.env.CLOUD_META_DB_URL
const nowMs = (): number => Date.now()
const secOf = (ms: number): number => Math.floor(ms / 1000)

// ── #2155 streams ────────────────────────────────────────────────────────────
export type StreamKind = 'graphql-sse' | 'events-sse' | 'view-sse' | 'admin-sse' | 'graphql-ws'
export const STREAM_KINDS: ReadonlyArray<{ kind: StreamKind; label: string; hint: string }> = [
  {
    kind: 'graphql-sse',
    label: 'GraphQL streams (SSE)',
    hint: 'subscriptions over /graphql/stream'
  },
  {
    kind: 'graphql-ws',
    label: 'GraphQL subscriptions (WebSocket)',
    hint: 'graphql-ws connections'
  },
  { kind: 'events-sse', label: 'Record event streams (SSE)', hint: '/events/stream fallback feed' },
  { kind: 'view-sse', label: 'Saved view streams (SSE)', hint: 'live saved views' },
  { kind: 'admin-sse', label: 'Admin change feed (SSE)', hint: '/stream, administrators only' }
]
const STREAM_LABEL = new Map(STREAM_KINDS.map((s) => [s.kind, s.label]))
/** The id a stream kind has as a map source. */
export const streamSourceId = (kind: StreamKind): string => `stream:${kind}`
/** The Sockets-lane entity its edge lands on (beside `connect`, `record.join`…). */
export const streamEntityKey = (kind: StreamKind): string => `socket/stream.${kind}`
// slots of a stream kind's minute counters
const ST = { opened: 0, events: 1, bytes: 2, closed: 3 } as const

interface StreamState {
  open: number
  peak: number
  slots: MinuteSlots
}
interface RoomEvent {
  at: number
  event: string
  bytes: number
  /** Consecutive identical deliveries folded into this row (one per member). */
  n: number
}
interface RoomState {
  // broadcasts, deliveries, bytes
  slots: MinuteSlots
  ring: RoomEvent[]
  lastAt: number
}
interface SockInfo {
  browser: string
  network: string
  app: string
  transport: string
  at: number
}
interface ReportGroup {
  kind: 'failed' | 'downgraded'
  app: string
  browser: string
  network: string
  transport: string
  reason: string
  n: number
  people: Set<string>
  firstAt: number
  lastAt: number
}
interface LagMinute {
  min: number
  n: number
  sum: number
  max: number
}
interface State {
  streams: Map<StreamKind, StreamState>
  rooms: Map<string, RoomState>
  sockets: Map<string, SockInfo>
  reports: Map<string, ReportGroup>
  lag: { mins: LagMinute[]; last: number | null; lastAt: number | null; total: number }
}
const LAG_MINUTES = 16
const state = (): State =>
  tapState<State>(REALTIME_TAP, () => ({
    streams: new Map(),
    rooms: new Map(),
    sockets: new Map(),
    reports: new Map(),
    lag: { mins: [], last: null, lastAt: null, total: 0 }
  }))

function streamOf(kind: StreamKind): StreamState {
  const s = state().streams
  let st = s.get(kind)
  if (!st) {
    st = { open: 0, peak: 0, slots: new MinuteSlots(4) }
    s.set(kind, st)
  }
  return st
}

export interface StreamHandle {
  /** Bytes written to the stream; `event` = a real frame (not a heartbeat / comment). */
  write(bytes: number, event: boolean): void
  close(): void
}
const NOOP_HANDLE: StreamHandle = { write() {}, close() {} }

/** A stream opened. Returns its handle; the caller closes it when the connection ends. */
export function openStream(kind: StreamKind): StreamHandle {
  if (cloud()) return NOOP_HANDLE
  try {
    const st = streamOf(kind)
    const at = nowMs()
    st.open++
    if (st.open > st.peak) st.peak = st.open
    st.slots.add(secOf(at), ST.opened, 1)
    const id = streamSourceId(kind)
    const label = STREAM_LABEL.get(kind) ?? kind
    noteSource({ id, label, kind: 'stream', entityKey: streamEntityKey(kind), at })
    let closed = false
    return {
      write(bytes, event) {
        if (closed) return
        try {
          const t = nowMs()
          if (bytes > 0) st.slots.add(secOf(t), ST.bytes, bytes)
          if (event) {
            st.slots.add(secOf(t), ST.events, 1)
            noteSource({ id, label, kind: 'stream', entityKey: streamEntityKey(kind), at: t })
          }
        } catch {
          /* never */
        }
      },
      close() {
        if (closed) return
        closed = true
        try {
          st.open = Math.max(0, st.open - 1)
          st.slots.add(secOf(nowMs()), ST.closed, 1)
        } catch {
          /* never */
        }
      }
    }
  } catch {
    return NOOP_HANDLE
  }
}

interface SseLike {
  write: (...args: never[]) => unknown
  once: (ev: string, fn: () => void) => unknown
}

/**
 * Count an SSE response: bytes of everything written, events for every frame that is not a
 * comment / retry hint (heartbeats are `: …`). Wraps `raw.write` once; closes with the socket.
 */
export function trackSse(raw: unknown, kind: StreamKind): void {
  if (cloud()) return
  try {
    const r = raw as SseLike
    const h = openStream(kind)
    const orig = r.write.bind(r) as (...a: unknown[]) => unknown
    r.write = ((chunk: unknown, ...rest: unknown[]) => {
      try {
        const bytes =
          typeof chunk === 'string' ? Buffer.byteLength(chunk) : ((chunk as Buffer)?.length ?? 0)
        const isEvent = typeof chunk === 'string' && sseFrameIsEvent(chunk)
        h.write(bytes, isEvent)
      } catch {
        /* never */
      }
      return orig(chunk, ...rest)
    }) as never
    r.once('close', () => h.close())
  } catch {
    /* never */
  }
}

/** A frame with data / an event name — not a `: comment` heartbeat or a `retry:` hint. */
export function sseFrameIsEvent(frame: string): boolean {
  return !(frame.startsWith(':') || frame.startsWith('retry:'))
}

export interface StreamFigures {
  kind: StreamKind
  label: string
  hint: string
  open: number
  peak: number
  opened: number
  closed: number
  events: number
  bytes: number
}

export function streamFigures(windowS: number, sec = secOf(nowMs())): StreamFigures[] {
  const out: StreamFigures[] = []
  const st = state().streams
  for (const meta of STREAM_KINDS) {
    const s = st.get(meta.kind)
    if (!s) {
      out.push({ ...meta, open: 0, peak: 0, opened: 0, closed: 0, events: 0, bytes: 0 })
      continue
    }
    const sum = s.slots.sum(windowS, sec)
    out.push({
      ...meta,
      open: s.open,
      peak: s.peak,
      opened: sum[ST.opened],
      closed: sum[ST.closed],
      events: sum[ST.events],
      bytes: sum[ST.bytes]
    })
  }
  return out
}

// ── #2159 rooms ──────────────────────────────────────────────────────────────
const ROOM_CAP = 400
const ROOM_RING = 12
const R = { broadcasts: 0, deliveries: 1, bytes: 2 } as const

export type RoomKindClass = 'record' | 'collection' | 'chat' | 'watch' | 'user' | 'other'
export interface RoomDescription {
  cls: RoomKindClass
  /** Kind label (`record:projects:*`, `chat:dm:*`) — what a hidden room is shown as. */
  kind: string
  /** A room that names a person or private chat: shown as a kind + count only. */
  hidden: boolean
}

/** The coarse kind of a room name: ids folded away (mirrors socket-transport's roomKind). */
function kindLabel(room: string): string {
  if (room.startsWith('user:')) return 'user:*'
  if (room.startsWith('record:')) {
    const p = room.split(':')
    return p.length >= 3 ? `record:${p[1]}:*` : room
  }
  if (room.startsWith('chat:')) {
    const rest = room.slice(5)
    if (rest.startsWith('dm:')) return 'chat:dm:*'
    if (rest === 'global') return 'chat:global'
    return `chat:${rest.split(':')[0]}:*`
  }
  if (room.startsWith('presence:')) return 'presence:*'
  if (room.startsWith('watch:')) return room
  return room
}

/**
 * Classify a room name. Chat rooms (DMs, private channels, record rooms of chat) and `user:`
 * rooms are hidden — only `chat:global` is a public room — so the canSeeRoom rule holds: an
 * administrator never reads who is in a conversation they cannot open.
 */
export function describeRoom(raw: string): RoomDescription {
  const room = String(raw)
  const kind = kindLabel(room)
  if (room.startsWith('user:')) return { cls: 'user', kind, hidden: true }
  if (room.startsWith('chat:')) return { cls: 'chat', kind, hidden: room !== 'chat:global' }
  if (room.startsWith('record:')) return { cls: 'record', kind, hidden: false }
  if (room.startsWith('collection:')) return { cls: 'collection', kind, hidden: false }
  if (room.startsWith('watch:')) return { cls: 'watch', kind, hidden: false }
  return { cls: 'other', kind, hidden: false }
}

/** Sign-in rooms are never listed (session ids, masquerade hashes). */
function credentialRoom(room: string): boolean {
  return room.startsWith('session:') || room.startsWith('masq:')
}

function roomOf(room: string): RoomState | null {
  return boundedGet(state().rooms, room, ROOM_CAP, () => ({
    slots: new MinuteSlots(3),
    ring: [],
    lastAt: 0
  }))
}

/** One broadcast reached this replica for `room` (adapter.apply: local emits and relayed ones). */
export function noteRoomBroadcast(room: string | null): void {
  if (cloud() || !room || credentialRoom(room)) return
  try {
    const r = roomOf(room)
    if (!r) return
    const at = nowMs()
    r.slots.add(secOf(at), R.broadcasts, 1)
    r.lastAt = at
  } catch {
    /* never */
  }
}

/** One packet written to one member of `room`. */
export function noteRoomDelivery(room: string | null, event: string, bytes: number): void {
  if (cloud() || !room || credentialRoom(room)) return
  try {
    const r = roomOf(room)
    if (!r) return
    const at = nowMs()
    r.slots.add(secOf(at), R.deliveries, 1)
    if (bytes > 0) r.slots.add(secOf(at), R.bytes, bytes)
    r.lastAt = at
    const last = r.ring[r.ring.length - 1]
    if (last && last.event === event && at - last.at < 1000) {
      last.n++
      last.bytes += bytes
      return
    }
    r.ring.push({ at, event: String(event).slice(0, 60), bytes, n: 1 })
    if (r.ring.length > ROOM_RING) r.ring.shift()
  } catch {
    /* never */
  }
}

export interface RoomRow {
  /** The room name; for a hidden room its kind label. */
  room: string
  kind: string
  cls: RoomKindClass
  hidden: boolean
  /** Rooms folded into this row (1 for a visible room). */
  rooms: number
  members: number
  /** Broadcasts and deliveries per minute over the window. */
  broadcasts_pm: number
  deliveries_pm: number
  bytes_pm: number
}

/** Rank rooms from `{name → member count}` and the tap's counters. Pure over its inputs. */
export function rankRooms(
  members: Map<string, number>,
  windowS: number,
  sec: number,
  limit = 40
): { rows: RoomRow[]; total_rooms: number } {
  const st = state().rooms
  const minutes = Math.max(1, windowS / 60)
  const visible: RoomRow[] = []
  const hidden = new Map<string, RoomRow>()
  let total = 0
  const names = new Set<string>([...members.keys(), ...st.keys()])
  for (const name of names) {
    if (credentialRoom(name)) continue
    const m = members.get(name) ?? 0
    const s = st.get(name)
    const sum = s ? s.slots.sum(windowS, sec) : [0, 0, 0]
    // A room nobody is in and nothing was sent to is not a row.
    if (m === 0 && sum[R.deliveries] === 0 && sum[R.broadcasts] === 0) continue
    total++
    const d = describeRoom(name)
    const fig = {
      members: m,
      broadcasts_pm: sum[R.broadcasts] / minutes,
      deliveries_pm: sum[R.deliveries] / minutes,
      bytes_pm: sum[R.bytes] / minutes
    }
    if (d.hidden) {
      const cur = hidden.get(d.kind)
      if (cur) {
        cur.rooms++
        cur.members += fig.members
        cur.broadcasts_pm += fig.broadcasts_pm
        cur.deliveries_pm += fig.deliveries_pm
        cur.bytes_pm += fig.bytes_pm
      } else {
        hidden.set(d.kind, {
          room: d.kind,
          kind: d.kind,
          cls: d.cls,
          hidden: true,
          rooms: 1,
          ...fig
        })
      }
    } else {
      visible.push({ room: name, kind: d.kind, cls: d.cls, hidden: false, rooms: 1, ...fig })
    }
  }
  const rows = [...visible, ...hidden.values()]
  // Busiest by traffic first, then by members: the page re-sorts by either column.
  rows.sort((a, b) => b.deliveries_pm - a.deliveries_pm || b.members - a.members)
  const byMembers = [...rows].sort((a, b) => b.members - a.members)
  const keep = new Set<RoomRow>([...rows.slice(0, limit), ...byMembers.slice(0, limit)])
  return { rows: rows.filter((r) => keep.has(r)), total_rooms: total }
}

/** Live member counts per room on THIS replica (socket-id rooms left out). */
export function localRoomMembers(): Map<string, number> {
  const out = new Map<string, number>()
  const io = getIo()
  if (!io) return out
  for (const [room, set] of io.sockets.adapter.rooms) {
    if (io.sockets.sockets.has(room) || credentialRoom(room)) continue
    out.set(room, set.size)
  }
  return out
}

export interface RoomDetail {
  room: string
  kind: string
  members: Array<{ id: string; name: string; sockets: number }>
  members_total: number
  recent: Array<{ at: string; event: string; bytes: number; n: number }>
}

/** One visible room's members and recent events; null when it is hidden, unknown or empty. */
export function roomDetail(
  room: string,
  userOf: (socketId: string) => { id: string; name: string } | null
): RoomDetail | null {
  const d = describeRoom(room)
  if (d.hidden || credentialRoom(room)) return null
  const io = getIo()
  const set = io?.sockets.adapter.rooms.get(room)
  const ring = state().rooms.get(room)?.ring ?? []
  if (!set && ring.length === 0) return null
  const byUser = new Map<string, { id: string; name: string; sockets: number }>()
  let anon = 0
  for (const sid of set ?? []) {
    const u = userOf(sid)
    if (!u) {
      anon++
      continue
    }
    const cur = byUser.get(u.id)
    if (cur) cur.sockets++
    else byUser.set(u.id, { id: u.id, name: u.name, sockets: 1 })
  }
  const members = [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name))
  return {
    room,
    kind: d.kind,
    members: members.slice(0, 60),
    members_total: members.length + anon,
    recent: [...ring]
      .reverse()
      .map((e) => ({ at: new Date(e.at).toISOString(), event: e.event, bytes: e.bytes, n: e.n }))
  }
}

// ── #2263 connection failures ────────────────────────────────────────────────
const REPORT_CAP = 300
const REPORT_PEOPLE_CAP = 100
const REPORT_TTL_MS = 24 * 3600_000
const SOCKET_CAP = 20_000

/** A coarse browser label from a User-Agent: `Chrome`, `Edge`, `Firefox`, `Safari`, `Other`. */
export function browserOf(ua: string | null | undefined): string {
  const s = String(ua ?? '')
  if (!s) return 'Unknown'
  const mobile = /Mobi|Android|iPhone|iPad/i.test(s)
  let b = 'Other'
  if (/Edg(e|A|iOS)?\//.test(s)) b = 'Edge'
  else if (/OPR\/|Opera/.test(s)) b = 'Opera'
  else if (/Firefox\/|FxiOS\//.test(s)) b = 'Firefox'
  else if (/Chrome\/|CriOS\//.test(s)) b = 'Chrome'
  else if (/Safari\//.test(s)) b = 'Safari'
  return mobile ? `${b} (mobile)` : b
}

/**
 * The coarse network a connection came from: an IPv4 address's /24, an IPv6 address's /48.
 * Admin-only — it names no person, but it does name an office or a provider.
 */
export function networkOf(ip: string | null | undefined): string {
  let s = String(ip ?? '').trim()
  if (!s) return 'unknown'
  if (s.startsWith('::ffff:')) s = s.slice(7)
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(s)
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`
  if (s.includes(':')) {
    const groups = s.split(':').filter((g) => g !== '')
    return groups.length >= 3 ? `${groups.slice(0, 3).join(':')}::/48` : 'unknown'
  }
  return 'unknown'
}

const slug = (v: unknown, max: number, fallback = 'unknown'): string => {
  const s = String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
  return s || fallback
}

export interface ConnectionReport {
  kind: 'failed' | 'downgraded'
  transport?: string | null
  reason?: string | null
  app?: string | null
}

/** Validate an untrusted body; null when it is not a report. */
export function parseConnectionReport(body: unknown): ConnectionReport | null {
  const b = body as Record<string, unknown> | null
  if (!b || typeof b !== 'object') return null
  if (b.kind !== 'failed' && b.kind !== 'downgraded') return null
  return {
    kind: b.kind,
    transport: typeof b.transport === 'string' ? slug(b.transport, 20) : null,
    reason: typeof b.reason === 'string' ? slug(b.reason, 40) : null,
    app: typeof b.app === 'string' ? slug(b.app, 24) : null
  }
}

/** One client report. `who` = the reporting user's id (only ever counted, never returned). */
export function noteConnectionReport(
  r: ConnectionReport,
  who: string,
  ua: string | null | undefined,
  ip: string | null | undefined,
  at = nowMs()
): void {
  if (cloud()) return
  try {
    const reports = state().reports
    const g: Omit<ReportGroup, 'n' | 'people' | 'firstAt' | 'lastAt'> = {
      kind: r.kind,
      app: r.app || 'unknown',
      browser: browserOf(ua),
      network: networkOf(ip),
      transport: r.transport || 'unknown',
      reason: r.reason || 'unknown'
    }
    const key = [g.kind, g.app, g.browser, g.network, g.transport, g.reason].join('|')
    let cur = reports.get(key)
    if (!cur) {
      if (reports.size >= REPORT_CAP) {
        for (const [k, v] of reports) if (at - v.lastAt > REPORT_TTL_MS) reports.delete(k)
        // Still full: the least recently seen group makes room, so one reporter cycling made-up
        // slugs can push out stale groups but never lock new ones out for a day.
        if (reports.size >= REPORT_CAP) {
          let oldest: string | null = null
          let oldestAt = Number.POSITIVE_INFINITY
          for (const [k, v] of reports) {
            if (v.lastAt < oldestAt) {
              oldestAt = v.lastAt
              oldest = k
            }
          }
          if (oldest) reports.delete(oldest)
        }
      }
      cur = { ...g, n: 0, people: new Set(), firstAt: at, lastAt: at }
      reports.set(key, cur)
    }
    cur.n++
    cur.lastAt = at
    if (cur.people.size < REPORT_PEOPLE_CAP) cur.people.add(who)
  } catch {
    /* never */
  }
}

/** A socket connected: remember what the server can see of it (never the address itself). */
export function noteSocketOpen(
  id: string,
  headers: Record<string, unknown> | undefined,
  address: string | null | undefined,
  transport: string | null | undefined
): void {
  if (cloud()) return
  try {
    const m = state().sockets
    if (m.size >= SOCKET_CAP) return
    // Behind a proxy the handshake address is the proxy's; its forwarded-for names the client.
    const fwd = String(headers?.['x-forwarded-for'] ?? '')
      .split(',')[0]
      ?.trim()
    m.set(id, {
      browser: browserOf(String(headers?.['user-agent'] ?? '')),
      network: networkOf(fwd || address),
      app: 'unknown',
      transport: transport || 'unknown',
      at: nowMs()
    })
  } catch {
    /* never */
  }
}
export function noteSocketTransport(id: string, transport: string | null | undefined): void {
  const s = state().sockets.get(id)
  if (s && transport) s.transport = transport
}
export function noteSocketApp(id: string, app: string | null | undefined): void {
  const s = state().sockets.get(id)
  if (s && app) s.app = slug(app, 24)
}
export function noteSocketClose(id: string): void {
  state().sockets.delete(id)
}

export interface FailureBucket {
  key: string
  n: number
  people: number
}
export interface ConnectionFailures {
  since_h: number
  total: number
  failed: number
  downgraded: number
  by_network: FailureBucket[]
  by_browser: FailureBucket[]
  by_app: FailureBucket[]
  /** The top groups across all three dimensions, for the table. */
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
  /** Sockets on this replica using long-polling right now, per app / browser / network. */
  polling_now: {
    total: number
    sockets: number
    by_network: FailureBucket[]
    by_browser: FailureBucket[]
    by_app: FailureBucket[]
  }
}

function bucketize(groups: ReportGroup[], dim: 'network' | 'browser' | 'app'): FailureBucket[] {
  const m = new Map<string, { n: number; people: Set<string> }>()
  for (const g of groups) {
    const cur = m.get(g[dim]) ?? { n: 0, people: new Set<string>() }
    cur.n += g.n
    for (const p of g.people) cur.people.add(p)
    m.set(g[dim], cur)
  }
  return [...m.entries()]
    .map(([key, v]) => ({ key, n: v.n, people: v.people.size }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 15)
}

/** Reports of the last `hours`, grouped; plus the long-polling sockets connected right now. */
export function connectionFailures(hours = 24, now = nowMs()): ConnectionFailures {
  const st = state()
  const since = now - hours * 3600_000
  const live = [...st.reports.values()].filter((g) => g.lastAt >= since)
  let failed = 0
  let downgraded = 0
  for (const g of live) {
    if (g.kind === 'failed') failed += g.n
    else downgraded += g.n
  }
  const polling = [...st.sockets.values()].filter((s) => s.transport === 'polling')
  const pollGroups = (dim: 'network' | 'browser' | 'app'): FailureBucket[] => {
    const m = new Map<string, number>()
    for (const s of polling) m.set(s[dim], (m.get(s[dim]) ?? 0) + 1)
    return [...m.entries()]
      .map(([key, n]) => ({ key, n, people: n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 15)
  }
  return {
    since_h: hours,
    total: failed + downgraded,
    failed,
    downgraded,
    by_network: bucketize(live, 'network'),
    by_browser: bucketize(live, 'browser'),
    by_app: bucketize(live, 'app'),
    groups: live
      .sort((a, b) => b.n - a.n)
      .slice(0, 25)
      .map((g) => ({
        kind: g.kind,
        app: g.app,
        browser: g.browser,
        network: g.network,
        transport: g.transport,
        reason: g.reason,
        n: g.n,
        people: g.people.size,
        last_at: new Date(g.lastAt).toISOString()
      })),
    polling_now: {
      total: polling.length,
      sockets: st.sockets.size,
      by_network: pollGroups('network'),
      by_browser: pollGroups('browser'),
      by_app: pollGroups('app')
    }
  }
}

// ── #2266 adapter lag ────────────────────────────────────────────────────────
/** Warn above this average lag (ms); error at four times it. `ADAPTER_LAG_WARN_MS` overrides. */
export function lagWarnMs(): number {
  const n = Number(process.env.ADAPTER_LAG_WARN_MS)
  return Number.isFinite(n) && n > 0 ? n : 500
}

/**
 * One journaled event written by ANOTHER replica reached this one `lagMs` after it was written
 * (the Redis stream entry carries the writer's clock; replica clocks that disagree show up here
 * as lag, so the page says so).
 */
export function noteAdapterLag(lagMs: number, at = nowMs()): void {
  if (cloud() || !Number.isFinite(lagMs)) return
  try {
    const lag = state().lag
    const ms = Math.max(0, lagMs)
    const min = Math.floor(at / 60_000)
    const i = min % LAG_MINUTES
    let slot = lag.mins[i]
    if (!slot || slot.min !== min) {
      slot = { min, n: 0, sum: 0, max: 0 }
      lag.mins[i] = slot
    }
    slot.n++
    slot.sum += ms
    if (ms > slot.max) slot.max = ms
    lag.last = ms
    lag.lastAt = at
    lag.total++
  } catch {
    /* never */
  }
}

export type LagLevel = 'idle' | 'ok' | 'warn' | 'error'
export interface AdapterLag {
  level: LagLevel
  warn_ms: number
  last_ms: number | null
  last_at: string | null
  /** Deliveries from other replicas seen since this process started. */
  total: number
  /** Per minute, oldest first, the last 15 minutes: samples, average and worst lag. */
  minutes: Array<{ min: number; n: number; avg_ms: number; max_ms: number }>
  recent_avg_ms: number | null
  recent_max_ms: number | null
  /** Average over the older minutes of the window (the baseline "growing" is judged against). */
  baseline_avg_ms: number | null
  growing: boolean
}

/**
 * Judge the lag: error at 4x the warn line, warn above it, or when the last three minutes run
 * at least double the older baseline (and over 100 ms) — "it is growing" before it is high.
 * Pure.
 */
export function judgeLag(
  recentAvg: number | null,
  baselineAvg: number | null,
  warnMs: number
): { level: LagLevel; growing: boolean } {
  if (recentAvg == null) return { level: 'idle', growing: false }
  const growing = baselineAvg != null && recentAvg > 100 && recentAvg >= baselineAvg * 2
  if (recentAvg >= warnMs * 4) return { level: 'error', growing }
  if (recentAvg >= warnMs || growing) return { level: 'warn', growing }
  return { level: 'ok', growing }
}

export function adapterLagFigures(now = nowMs(), warnMs = lagWarnMs()): AdapterLag {
  const lag = state().lag
  const cur = Math.floor(now / 60_000)
  const minutes: AdapterLag['minutes'] = []
  for (let k = 14; k >= 0; k--) {
    const mn = cur - k
    const s = lag.mins[mn % LAG_MINUTES]
    minutes.push(
      s && s.min === mn
        ? { min: mn, n: s.n, avg_ms: s.sum / s.n, max_ms: s.max }
        : { min: mn, n: 0, avg_ms: 0, max_ms: 0 }
    )
  }
  const agg = (ms: AdapterLag['minutes']) => {
    const n = ms.reduce((a, m) => a + m.n, 0)
    return n
      ? {
          avg: ms.reduce((a, m) => a + m.avg_ms * m.n, 0) / n,
          max: Math.max(...ms.map((m) => m.max_ms))
        }
      : null
  }
  const recent = agg(minutes.slice(-3))
  const older = agg(minutes.slice(0, -3))
  const verdict = judgeLag(recent?.avg ?? null, older?.avg ?? null, warnMs)
  return {
    level: verdict.level,
    warn_ms: warnMs,
    last_ms: lag.last,
    last_at: lag.lastAt ? new Date(lag.lastAt).toISOString() : null,
    total: lag.total,
    minutes,
    recent_avg_ms: recent?.avg ?? null,
    recent_max_ms: recent?.max ?? null,
    baseline_avg_ms: older?.avg ?? null,
    growing: verdict.growing
  }
}

// ── the tap ──────────────────────────────────────────────────────────────────
registerTrafficTap({
  id: REALTIME_TAP,
  // Rides the topology poll: a few numbers, so the canvas can badge the Sockets node.
  snapshot(windowS, sec) {
    if (cloud()) return undefined
    const s = state()
    const streams = streamFigures(windowS, sec)
    const lag = adapterLagFigures()
    const anything =
      streams.some((x) => x.open > 0 || x.events > 0) || lag.total > 0 || s.reports.size > 0
    if (!anything) return undefined
    return {
      streams: Object.fromEntries(
        streams.map((x) => [x.kind, { open: x.open, events: x.events, bytes: x.bytes }])
      ),
      lag: { level: lag.level, avg_ms: lag.recent_avg_ms, max_ms: lag.recent_max_ms }
    }
  },
  sweep(sec) {
    const s = state()
    const now = sec * 1000
    for (const [k, r] of s.rooms) if (now - r.lastAt > 3600_000) s.rooms.delete(k)
    for (const [k, g] of s.reports) if (now - g.lastAt > REPORT_TTL_MS) s.reports.delete(k)
  }
})
