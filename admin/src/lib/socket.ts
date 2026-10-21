import {
  type ClockSample,
  type CollectionUpdateEvent,
  createLeaderSocket,
  deliveryAckFor,
  forgetSettledReads,
  measureClockOffset,
  type RealtimeAdapter,
  type RealtimeStatus,
  relayLiveEvent,
  setServerClockOffset
} from '@nivaro/shared'
import { io, type Socket } from 'socket.io-client'
import { api } from '@/lib/api'
import { readMasquerade, stopMasquerade } from '@/lib/masquerade'
import { clientVersion } from '@/lib/page-context'
import { SOCKET_TRANSPORT_OPTIONS } from '@/lib/socket-transport'

/**
 * One shared authenticated socket for chat + collection feeds + realtime
 * surfaces. Realtime sprint v2:
 *
 * - FIX: collection subscriptions used to emit `join`, an event the server
 *   never handled (`collection:join` is the real one) — admin collection
 *   feeds were silently dead.
 * - Leader election (#277): only ONE tab joins collection rooms; followers
 *   receive collection events over a BroadcastChannel. Chat/presence keep
 *   their own per-tab socket behaviour (room-gated, low volume).
 * - Missed-event catch-up (#266): events carry `_seq`; on reconnect the
 *   client sends its cursor and replays the gap, or fires a full-refresh
 *   window event when the journal no longer covers it.
 * - `client:hello` reports reconnect count + app label; `nvr:ping`/`nvr:pong`
 *   feeds the /realtime RTT column; `client:force-refresh` (#285) surfaces as
 *   a window event AppLayout renders as a countdown banner.
 * - Transport fallback (#1672): websocket first, long-polling when the upgrade is blocked, and
 *   the read-only SSE stream (leader tab only) when the server refuses polling too.
 * - Coalesced bursts (#1681): `features: ['coalesce']` in client:hello; consumers read ids
 *   through updateItemIds/updateTouches.
 * - Session end (#1719) and room access changes (#1720) surface as window events; the
 *   connection state (#1725) feeds the reconnect banner and stale marks; `time:sync` (#2132)
 *   sets the server clock offset.
 */

const API_URL = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3055'

let socket: Socket | null = null
let reconnects = -1
let lastSeq = 0
let everAuthed = false

// ── Connection state (#1725) ────────────────────────────────────────────────
let status: RealtimeStatus = { state: 'live', transport: null, refreshed: null, resumed: null }
const statusListeners = new Set<(s: RealtimeStatus) => void>()
function setStatus(patch: Partial<RealtimeStatus>) {
  const next = { ...status, ...patch }
  if (
    next.state === status.state &&
    next.transport === status.transport &&
    next.refreshed === status.refreshed &&
    next.resumed === status.resumed
  )
    return
  status = next
  for (const l of statusListeners) l(status)
}
/** Waiting for the catch-up answer after a reconnect; the state turns live when it lands. */
let catchupTimer: ReturnType<typeof setTimeout> | null = null
function caughtUp(refreshed: string | null, resumed: NonNullable<RealtimeStatus['resumed']>) {
  if (catchupTimer) clearTimeout(catchupTimer)
  catchupTimer = null
  setStatus({ state: 'live', refreshed, resumed })
}

/**
 * #1719 — the server ended the sign-in this socket was opened under (logout in another tab, a
 * revoked or expired session, a suspended account, a View-as that stopped). The tab returns to
 * sign-in — unless the browser already holds a newer sign-in (the cookie moved on to a fresh
 * session), in which case the socket simply reconnects under it.
 */
let sessionEnded = false
async function onSessionEnded(reason: string | undefined) {
  if (sessionEnded) return
  sessionEnded = true
  closeSse()
  if (reason === 'masquerade_ended') {
    void stopMasquerade()
    return
  }
  const stillSignedIn = await fetch('/api/auth/me', { credentials: 'include', cache: 'no-store' })
    .then((r) => r.ok)
    .catch(() => false)
  if (stillSignedIn) {
    sessionEnded = false
    // The server closes the socket right after telling it; reconnect once it has.
    if (socket?.connected) socket.once('disconnect', () => socket?.connect())
    else socket?.connect()
    return
  }
  if (window.location.pathname === '/login') return
  const redirect = window.location.pathname + window.location.search
  const error =
    reason === 'expired'
      ? '&error=session_expired'
      : reason === 'account_inactive'
        ? '&error=suspended'
        : ''
  window.location.href = `/login?redirect=${encodeURIComponent(redirect)}${error}`
}

// ── Clock sync (#2132) ──────────────────────────────────────────────────────
function syncClock(s: Socket) {
  const samples: ClockSample[] = []
  const once = () =>
    new Promise<void>((resolve) => {
      const sent = Date.now()
      const t = setTimeout(resolve, 3000)
      s.emit('time:sync', { c: sent }, (r: { s?: number }) => {
        clearTimeout(t)
        if (typeof r?.s === 'number') samples.push({ sent, server: r.s, received: Date.now() })
        resolve()
      })
    })
  void (async () => {
    for (let i = 0; i < 3; i++) await once()
    const offset = measureClockOffset(samples)
    if (offset != null) setServerClockOffset(offset)
  })()
}

// ── SSE fallback (#1672) ────────────────────────────────────────────────────
// When neither websocket nor polling connects but the API answers plain HTTP, the server has
// polling off (no sticky sessions) and a proxy blocks the upgrade: the leader tab reads
// collection changes from GET /api/events/stream instead (read-only — chat, presence and
// watch rooms wait for the socket) and relays them to the other tabs like socket events.
let sseMode = false
let sse: EventSource | null = null
let sseKey = ''
let socketFailures = 0

// Traffic Map (#2263): tell the server when live updates fail or fall back, so a network or
// browser that keeps breaking them stands out. At most once per kind per ten minutes; best effort.
const reportedAt: Record<string, number> = {}
function reportConnection(kind: 'failed' | 'downgraded', transport: string, reason: string) {
  const key = `${kind}:${transport}`
  const now = Date.now()
  if (now - (reportedAt[key] ?? 0) < 600_000) return
  reportedAt[key] = now
  try {
    void api
      .post('/connection-reports', { kind, transport, reason, app: 'admin' })
      .catch(() => undefined)
  } catch {
    /* best effort */
  }
}
let leaderDeliver: ((event: string, payload: unknown) => void) | null = null

function closeSse() {
  sse?.close()
  sse = null
  sseKey = ''
}

function syncSse() {
  if (!sseMode || sessionEnded || typeof EventSource === 'undefined') return closeSse()
  // Only the leader carries the feed — one stream per browser, like the socket.
  if (!leaderDeliver) return closeSse()
  const cols = [...joinedCollections].sort()
  const key = cols.join(',')
  if (sse && key === sseKey) return
  closeSse()
  if (cols.length === 0) {
    setStatus({ state: 'live', transport: 'sse' })
    return
  }
  sseKey = key
  const stream = new EventSource(`/api/events/stream?collections=${encodeURIComponent(key)}`, {
    withCredentials: true
  })
  sse = stream
  stream.addEventListener('collection.update', (e) => {
    try {
      // The stream's _seq is per process, not the journal cursor — never feed lastSeq from it.
      const { _seq: _ignored, ...payload } = JSON.parse((e as MessageEvent).data)
      leaderDeliver?.('collection:update', payload)
    } catch {
      /* a malformed frame is skipped */
    }
  })
  stream.addEventListener('session.ended', () => void onSessionEnded('signed_out'))
  stream.onopen = () => setStatus({ state: 'live', transport: 'sse', refreshed: null })
  stream.onerror = () => {
    if (sse === stream) setStatus({ state: 'reconnecting' })
  }
}

async function considerSseFallback() {
  socketFailures++
  if (sseMode || socketFailures < 2) return
  // A View-as tab never falls back (H9): EventSource cannot send the View-as token, so the
  // stream would open on the administrator's own cookie and show their events in this tab.
  if (readMasquerade()) return
  const reachable = await fetch('/api/version', { cache: 'no-store', credentials: 'include' })
    .then((r) => r.ok)
    .catch(() => false)
  // The API is down, not blocked: the socket's own reconnect handles that.
  if (!reachable || sseMode || socket?.connected) return
  reportConnection('downgraded', 'sse', 'socket-blocked')
  sseMode = true
  syncSse()
}

function leaveSseMode() {
  socketFailures = 0
  if (!sseMode) return
  sseMode = false
  closeSse()
}

async function authToken(): Promise<string | null> {
  try {
    const r = await api.get<{ data?: { token?: string }; token?: string }>('/auth/ws-token')
    return r.data.data?.token ?? r.data.token ?? null
  } catch {
    return null
  }
}

export function getSocket(): Socket {
  if (socket) return socket
  socket = io(API_URL, {
    ...SOCKET_TRANSPORT_OPTIONS,
    withCredentials: true,
    reconnection: true,
    // Reconnect jitter (#332): after an API restart every open tab reconnects
    // at once — randomized backoff spreads the stampede over a window.
    reconnectionDelay: 1500 + Math.floor(Math.random() * 2500),
    reconnectionDelayMax: 15_000,
    randomizationFactor: 0.6
  })
  socket.on('connect', () => {
    leaveSseMode()
    reconnects += 1
    void authToken().then((token) => {
      if (token) socket?.emit('auth', { token })
    })
  })
  socket.on('connect_error', (err?: Error) => {
    if (sessionEnded) return
    reportConnection(
      'failed',
      socket?.io.engine?.transport?.name ?? 'unknown',
      err?.message ?? 'connect_error'
    )
    if (!sseMode) setStatus({ state: 'reconnecting', refreshed: null })
    void considerSseFallback()
  })
  socket.on('disconnect', () => {
    if (sessionEnded) return
    if (catchupTimer) clearTimeout(catchupTimer)
    catchupTimer = null
    setStatus({ state: 'reconnecting', refreshed: null })
  })
  socket.on('session:ended', (p: { reason?: string }) => void onSessionEnded(p?.reason))
  // #1720 — the server took rooms away after a permission change: what this tab shows may
  // include things the person can no longer see, so every cached read is fetched again.
  socket.on('access:changed', (p: { rooms_left?: string[] }) => {
    forgetSettledReads()
    if (!p?.rooms_left?.length) return
    window.dispatchEvent(new CustomEvent('nvr:access-changed', { detail: p }))
  })
  socket.on('auth:ok', () => {
    const engine = socket?.io.engine
    const transportName = () =>
      (engine?.transport?.name as RealtimeStatus['transport'] | undefined) ?? null
    engine?.once('upgrade', () => setStatus({ transport: transportName() }))
    if (transportName() === 'polling') reportConnection('downgraded', 'polling', 'polling-fallback')
    // #1048 — the same build signal every request carries (x-nivaro-client).
    socket?.emit('client:hello', {
      reconnects: Math.max(0, reconnects),
      app: 'admin',
      features: ['coalesce'],
      transport: transportName(),
      ...clientVersion()
    })
    if (socket) syncClock(socket)
    // Rejoin what this tab holds, then replay whatever happened while away.
    for (const room of joinedCollections) socket?.emit('collection:join', { collection: room })
    // Watch rooms ride the LEADER's socket only (a follower's own socket joining one would keep
    // the server emitting to a tab that never relays it). The leader holds every tab's joins.
    if (!leaderHandle || leaderHandle.isLeader()) {
      for (const room of new Set([...leaderWatchRefs.keys(), ...localWatchRefs.keys()]))
        socket?.emit('admin:join', { room })
    }
    // Live operations pages (ops:join) ride the leader's socket like the watch rooms.
    if (!leaderHandle || leaderHandle.isLeader()) {
      for (const topic of new Set([...leaderOpsRefs.keys(), ...localOpsRefs.keys()]))
        socket?.emit('ops:join', { topic })
    }
    if (everAuthed && lastSeq > 0) {
      const cursor = lastSeq
      setStatus({ transport: transportName() })
      // Live once the catch-up answers (or after a while without one — the replay is a bonus).
      if (catchupTimer) clearTimeout(catchupTimer)
      catchupTimer = setTimeout(() => caughtUp(null, 'unverified'), 8000)
      setTimeout(() => socket?.emit('catchup', { cursor }), Math.random() * 2000)
    } else {
      // #2450 — a reconnect with no cursor could not replay what it missed (the live-query
      // bridge reconciles); a first connection has nothing to catch up on.
      setStatus({
        state: 'live',
        transport: transportName(),
        refreshed: null,
        resumed: everAuthed && status.state === 'reconnecting' ? 'unverified' : null
      })
    }
    everAuthed = true
  })
  // #2450 — the journal position at sign-in: a reconnect replays from here even when no event
  // reached this socket yet (a quiet tab used to have no cursor, so it missed the gap).
  socket.on('catchup:cursor', (p: { seq?: number }) => {
    if (lastSeq === 0 && typeof p?.seq === 'number' && p.seq > 0) lastSeq = p.seq
  })
  socket.on('nvr:ping', (p: { t?: number }) => socket?.emit('nvr:pong', { t: p?.t }))
  socket.onAny((_event, payload) => {
    const seq = (payload as { _seq?: number } | undefined)?._seq
    if (typeof seq === 'number' && seq > lastSeq) lastSeq = seq
    // #2477 — a sampled event asks for its receive time (the delivery SLO's real clients).
    const ack = deliveryAckFor(payload)
    if (ack) socket?.emit('rt:ack', ack)
  })
  socket.on(
    'catchup:events',
    (p: { events?: Array<{ seq: number; event: string; payload: Record<string, unknown> }> }) => {
      for (const ev of p?.events ?? []) {
        if (ev.seq > lastSeq) lastSeq = ev.seq
        // Re-dispatch into local listeners as if it arrived live.
        for (const l of socket?.listeners(ev.event) ?? []) {
          l({ ...ev.payload, _seq: ev.seq })
        }
      }
      caughtUp(null, 'replayed')
    }
  )
  socket.on('catchup:full', () => {
    window.dispatchEvent(new CustomEvent('nvr:catchup-full'))
    caughtUp(
      'Live updates resumed. The connection was gone too long to replay each change, so the lists and records on this page were reloaded.',
      'reloaded'
    )
  })
  socket.on('client:force-refresh', (p: { seconds?: number; message?: string }) => {
    window.dispatchEvent(new CustomEvent('nvr:force-refresh', { detail: p ?? {} }))
  })
  // Config hot-push (#268): schema/layout edits broadcast — open forms
  // re-resolve their field-config/layout queries in place.
  socket.on('config:update', (p: { surface?: string; collection?: string }) => {
    // the refetch this triggers must reach the server, not the 3 s settled answer
    forgetSettledReads()
    window.dispatchEvent(new CustomEvent('nvr:config-update', { detail: p ?? {} }))
  })
  // Notices for the signed-in person or the whole tenant (payload-free or ids only): handed to
  // the shared live hooks (lib/live.ts useLiveEvent) — jobs tray #1724, bulk rows #1827,
  // announcements #1744, feature flags #1741.
  for (const ev of ['job:progress', 'bulk:rows', 'announcements:changed', 'flags:changed']) {
    socket.on(ev, (payload: unknown) => relayLiveEvent(ev, payload))
  }
  return socket
}

// ── Collection feed via leader election ─────────────────────────────────────
// Only the LEADER tab joins collection rooms + relays events to followers.
// joinedCollections tracks bare collection names the leader must be in.
const joinedCollections = new Set<string>()
/** This tab's own watch-room joins, reference counted (two panels may watch one room). */
const localWatchRefs = new Map<string, number>()
/** This tab's live-operations topic joins (`ops:join`), reference counted. */
const localOpsRefs = new Map<string, number>()
/** Leader only: every tab's topic joins (a follower's joins reach the leader as sentinels). */
const leaderOpsRefs = new Map<string, number>()

/**
 * Leader only: every tab's joins, reference counted. A follower closing its page sends
 * `__leave_watch`; the leader leaves the server room only when the LAST watcher is gone —
 * otherwise a second tab on the same page would stop receiving events.
 */
const leaderWatchRefs = new Map<string, number>()

const RELAYED_EVENTS = new Set([
  'collection:update',
  'job:update',
  'import:progress',
  'job:log',
  'conformance:progress',
  'help-video:changed',
  'help-video:question',
  'monitor:status',
  'traffic:request',
  'ai:call',
  'traffic-map:frame',
  'traffic-map:viewer',
  'lock:requested',
  'lock:response',
  'lock:available',
  'lock:queued',
  'record:uploading',
  'ops:changed',
  'ops:incident',
  'notification:new',
  'presence:changed',
  'read:changed',
  'prefs:changed',
  // #1675 — pushed widgets: the figure computed as this sign-in, for this tab's own watch key.
  'widget:watching',
  'widget:data',
  'widget:stale',
  'widget:unwatched'
])

let leaderHandle: ReturnType<typeof createLeaderSocket> | null = null

function ensureLeaderSocket() {
  if (leaderHandle) return leaderHandle
  // A "View as" tab is someone else: it must neither lead nor follow the
  // admin's own tabs, or one identity's feed would stand in for the other's.
  const masq = readMasquerade()
  leaderHandle = createLeaderSocket(masq ? `admin-feed:as:${masq.user_id}` : 'admin-feed', {
    becomeLeader(deliver, emitRef) {
      const s = getSocket()
      leaderDeliver = deliver
      syncSse()
      for (const c of joinedCollections) {
        if (s.connected) s.emit('collection:join', { collection: c })
      }
      // Seed from this tab's own joins (they were sent to the previous leader as a follower).
      leaderWatchRefs.clear()
      for (const [r, n] of localWatchRefs) {
        leaderWatchRefs.set(r, n)
        if (s.connected) s.emit('admin:join', { room: r })
      }
      leaderOpsRefs.clear()
      for (const [r, n] of localOpsRefs) {
        leaderOpsRefs.set(r, n)
        if (s.connected) s.emit('ops:join', { topic: r })
      }
      s.onAny((event, payload) => {
        if (RELAYED_EVENTS.has(event)) deliver(event, payload)
      })
      emitRef.current = (event, payload) => {
        const so = getSocket()
        if (event === '__join_collection') {
          joinedCollections.add(String(payload))
          if (so.connected) so.emit('collection:join', { collection: payload })
          else syncSse()
        } else if (event === '__join_watch') {
          const r = String(payload)
          leaderWatchRefs.set(r, (leaderWatchRefs.get(r) ?? 0) + 1)
          if (so.connected) so.emit('admin:join', { room: r })
        } else if (event === '__join_ops' || event === '__leave_ops') {
          const r = String(payload)
          const n = (leaderOpsRefs.get(r) ?? 0) + (event === '__join_ops' ? 1 : -1)
          if (n > 0) {
            leaderOpsRefs.set(r, n)
            if (event === '__join_ops' && so.connected) so.emit('ops:join', { topic: r })
          } else {
            leaderOpsRefs.delete(r)
            if (so.connected) so.emit('ops:leave', { topic: r })
          }
        } else if (event === '__leave_watch') {
          const r = String(payload)
          const n = (leaderWatchRefs.get(r) ?? 0) - 1
          if (n > 0) leaderWatchRefs.set(r, n)
          else {
            leaderWatchRefs.delete(r)
            if (so.connected) so.emit('admin:leave', { room: r })
          }
        } else {
          so.emit(event, payload)
        }
      }
    },
    resignLeader() {
      // The socket stays up for chat; we just stop being the feed source.
      leaderWatchRefs.clear()
      leaderOpsRefs.clear()
      leaderDeliver = null
      closeSse()
    }
  })
  return leaderHandle
}

/** RealtimeAdapter for shared components (CBV patches, RecordLiveSync, MyWork). */
export const adminRealtime: RealtimeAdapter = {
  subscribeCollections(collections, cb) {
    const handle = ensureLeaderSocket()
    for (const c of collections) {
      // Track locally too — if this tab later PROMOTES to leader it must know
      // which rooms to join (the sentinel emit only reaches the current leader).
      joinedCollections.add(c)
      handle.emit('__join_collection', c)
    }
    const off = handle.onEvent((event, payload) => {
      if (event !== 'collection:update') return
      const p = payload as { collection?: string; item?: string | number }
      if (p?.collection && collections.includes(p.collection)) cb(p as never)
    })
    return off
  },
  on(event, cb) {
    const handle = ensureLeaderSocket()
    return handle.onEvent((ev, payload) => {
      if (ev === event) cb(payload)
    })
  },
  emit(event, payload) {
    const handle = ensureLeaderSocket()
    // Topic joins are reference counted and re-sent after a reconnect (auth:ok above).
    if (event === 'ops:join' || event === 'ops:leave') {
      const topic = String((payload as { topic?: string } | undefined)?.topic ?? '')
      if (!topic) return
      const n = (localOpsRefs.get(topic) ?? 0) + (event === 'ops:join' ? 1 : -1)
      if (n > 0) localOpsRefs.set(topic, n)
      else localOpsRefs.delete(topic)
      handle.emit(event === 'ops:join' ? '__join_ops' : '__leave_ops', topic)
      return
    }
    handle.emit(event, payload)
  },
  status() {
    return status
  },
  onStatus(cb) {
    // The state is this tab's own socket; make sure there is one to report on.
    getSocket()
    statusListeners.add(cb)
    return () => {
      statusListeners.delete(cb)
    }
  },
  joinWatch(room) {
    return joinWatchRoom(room)
  }
}

/** Join an admin watch room (traffic/jobs/monitors); returns leave fn. */
export function joinWatchRoom(room: string): () => void {
  const handle = ensureLeaderSocket()
  localWatchRefs.set(room, (localWatchRefs.get(room) ?? 0) + 1)
  handle.emit('__join_watch', room)
  let left = false
  return () => {
    if (left) return // a double cleanup must not drop another watcher's reference
    left = true
    const n = (localWatchRefs.get(room) ?? 1) - 1
    if (n > 0) localWatchRefs.set(room, n)
    else localWatchRefs.delete(room)
    handle.emit('__leave_watch', room)
  }
}

/** Subscribe to live updates for a collection; returns an unsubscribe. */
export function onCollectionUpdate(
  collection: string,
  handler: (payload?: CollectionUpdateEvent) => void
): () => void {
  return adminRealtime.subscribeCollections([collection], (ev) => handler(ev))
}

/**
 * Chat delivery. The server emits `chat:message` only to `chat:<room>`, and
 * joining one is gated server-side by the room-visibility check — so this
 * subscribes per room rather than listening to every chat_messages write.
 */
export function subscribeChatRooms<T>(rooms: string[], handler: (msg: T) => void): () => void {
  const s = getSocket()
  const joinAll = () => {
    for (const room of rooms) s.emit('chat:join', { room })
  }
  if (s.connected) joinAll()
  s.on('auth:ok', joinAll)
  const listener = (payload: unknown) => handler(payload as T)
  s.on('chat:message', listener)
  return () => {
    for (const room of rooms) s.emit('chat:leave', { room })
    s.off('chat:message', listener)
    s.off('auth:ok', joinAll)
  }
}
