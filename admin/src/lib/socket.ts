import {
  attachSocketLiveness,
  bindClientChaosSocket,
  type ClockSample,
  type CollectionUpdateEvent,
  createJitteredReaction,
  createLeaderSocket,
  createRecordGapTracker,
  createRecordRoomHolds,
  createRoomGapTracker,
  createSocketRealtime,
  createWorkerSocket,
  deliveryAckFor,
  forgetSettledReads,
  guardIdentityCall,
  type LivenessHandle,
  liveCollectionEventPasses,
  liveEventQuiet,
  measureClockOffset,
  noteWriteToScreenEvent,
  parseSignOutNote,
  type RealtimeAdapter,
  type RealtimeStatus,
  recordRefetchEvent,
  refetchEventsFor,
  relayLiveEvent,
  SIGN_OUT_NOTE_EVENT,
  type SocketLike,
  type SocketRealtime,
  saveSignOutNote,
  setServerClockOffset,
  shouldUseWorkerSocket,
  tapReplaySocket,
  type WorkerSocket
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
 * - Missed events while connected (#2462): a room whose own counter (`_rseq`) skips is caught up
 *   alone (`catchup:room`); `realtime:stale` (#2460, the server held this tab's broadcasts while
 *   it was too far behind) refetches the rooms it names.
 * - Missed changes per record (realtime 23): a record whose own counter (`_iseq`) skips is
 *   re-read alone, also after a reconnect whose catch-up went unanswered (record-gaps.ts).
 * - Silent self-repair (realtime 24): this tab's own socket is watched (socket-liveness.ts) —
 *   a connection that says it is up but is dead is reopened quietly; `status.repair` keeps the
 *   banner away unless the repair fails twice. On the shared worker the worker does it.
 * - One socket per browser (#2475): when the browser has SharedWorker and the API serves the
 *   worker script, `getSocket()` is a facade over the shared worker's port (every tab, one
 *   connection, rooms and catch-up owned by the worker) and the shared `createSocketRealtime`
 *   is the adapter. The leader-tab model below is the fallback: no SharedWorker, a View-as
 *   tab, the worker switched off (`REALTIME_SHARED_WORKER=off`, localStorage
 *   `nvr-realtime-worker=off`), or a worker that cannot connect while the API answers HTTP.
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
    next.resumed === status.resumed &&
    (next.repair ?? null) === (status.repair ?? null)
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
  endRepair()
}
/** Realtime 24 — this tab's socket watch (per-tab socket only). */
let liveness: LivenessHandle | null = null
/** A quiet repair signed in again: the status stays quiet until its catch-up has answered. */
let repairEnding = false
function endRepair() {
  if (!repairEnding) return
  repairEnding = false
  setStatus({ repair: null })
}

/**
 * Hand a replayed or synthetic event to this tab's listeners as if it had arrived live: the
 * socket's own listeners and, on the leader tab, every tab's feed (live packets reach the feed
 * through `onAny`, which a replay never passes).
 */
function relayLocal(event: string, payload: Record<string, unknown>) {
  for (const l of socket?.listeners(event) ?? []) l(payload)
  if (RELAYED_EVENTS.has(event)) leaderDeliver?.(event, payload)
}
function refetchRooms(rooms: string[]) {
  recordGaps.forget(rooms.filter((r) => r.startsWith('collection:')).map((r) => r.slice(11)))
  for (const ev of refetchEventsFor(rooms)) relayLocal(ev.event, ev.payload)
  window.dispatchEvent(new CustomEvent('nvr:realtime-stale', { detail: { rooms } }))
}
/** Realtime 23 — a record that skipped a change is re-read alone (this tab's own socket). */
const recordGaps = createRecordGapTracker({
  refetch: (list) => {
    for (const r of list) {
      const ev = recordRefetchEvent(r)
      relayLocal(ev.event, ev.payload)
    }
  }
})
/** catchup:full and access:changed reach every tab at once (deploy, role change): each tab's
 *  reload reaction waits a random 0–3 s so the refetches do not hit the API as one wave. */
const later = createJitteredReaction()
const accessRoomsLeft = new Set<string>()
const roomGaps = createRoomGapTracker({
  request: (req) => socket?.emit('catchup:room', req),
  dispatch: (event, payload) => {
    recordGaps.observe(event, payload)
    relayLocal(event, payload)
  },
  refetch: refetchRooms
})

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
  // The shared worker's failures are its own to judge: it hands the tab its own socket when
  // the API answers HTTP but no transport connects, and that socket's errors land here.
  if (workerSocket && workerSocket.mode() !== 'fallback') return
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

/**
 * Mint a one-time socket token. Through the signed-out gate (@nivaro/shared signed-out.ts): a
 * signed-out tab asks once per backoff window (1 s doubling to 5 min), not on every connect —
 * staging saw 2,116 ws-token 401s in an hour from tabs whose session had ended.
 */
export async function mintWsToken(): Promise<string | null> {
  try {
    return await guardIdentityCall(
      async () => {
        const r = await api.get<{ data?: { token?: string }; token?: string }>('/auth/ws-token')
        return r.data.data?.token ?? r.data.token ?? null
      },
      () => null
    )
  } catch {
    return null
  }
}
const authToken = mintWsToken

// ── One socket per browser (#2475) ──────────────────────────────────────────
const WORKER_URL = `${API_URL}/api/realtime/worker.js`
let workerSocket: WorkerSocket | null = null
let workerDecided: boolean | null = null

/** Whether this tab shares the browser's socket (decided once, before the first socket). */
export function usesWorkerSocket(): boolean {
  if (workerDecided == null) workerDecided = !readMasquerade() && shouldUseWorkerSocket(WORKER_URL)
  return workerDecided
}

function openSocket(): Socket {
  const options = {
    ...SOCKET_TRANSPORT_OPTIONS,
    withCredentials: true,
    reconnection: true,
    // Reconnect jitter (#332): after an API restart every open tab reconnects
    // at once — randomized backoff spreads the stampede over a window.
    reconnectionDelay: 1500 + Math.floor(Math.random() * 2500),
    reconnectionDelayMax: 15_000,
    randomizationFactor: 0.6
  }
  if (!usesWorkerSocket()) return io(API_URL, options)
  workerSocket = createWorkerSocket({
    url: WORKER_URL,
    name: 'admin',
    app: 'admin',
    version: { ...clientVersion() },
    authToken,
    fallback: () => io(API_URL, options),
    onMode: (mode, reason) => {
      if (mode === 'fallback' && reason !== 'unsupported')
        reportConnection('downgraded', 'worker', reason)
    }
  })
  return workerSocket as unknown as Socket
}

export function getSocket(): Socket {
  if (socket) return socket
  socket = openSocket()
  // #2840 — browser chaos "socket gone" drops this tab's socket for its window (a worker facade
  // pauses itself; a per-tab socket disconnects and reconnects through the paths below).
  bindClientChaosSocket(socket)
  // #2476 — the session recorder lists the events this socket receives (names, rooms, ids).
  tapReplaySocket(socket)
  // Realtime 24 — a per-tab socket repairs itself quietly (the worker facade's watch lives in
  // the worker; its status reaches the page through the shared adapter, viaWorker).
  if (!usesWorkerSocket()) {
    liveness = attachSocketLiveness(socket)
    liveness?.onRepairing((on, outcome) => {
      repairEnding = !on && outcome === 'repaired'
      if (!repairEnding) setStatus({ repair: on ? 'silent' : null })
    })
  }
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
    // Quiet only while a repair runs (its watch set the flag before this listener ran).
    const quiet = !!liveness?.repairing()
    repairEnding = false
    setStatus({ state: 'reconnecting', refreshed: null, ...(quiet ? {} : { repair: null }) })
  })
  // An administrator signed this person out with a message (sign-out-note): keep it for the
  // sign-in page; `session:ended` arrives right after and takes the tab there.
  socket.on(SIGN_OUT_NOTE_EVENT, (p: unknown) => {
    const note = parseSignOutNote(p)
    if (note) saveSignOutNote(note)
  })
  socket.on('session:ended', (p: { reason?: string }) => void onSessionEnded(p?.reason))
  // #1720 — the server took rooms away after a permission change: what this tab shows may
  // include things the person can no longer see, so every cached read is fetched again.
  socket.on('access:changed', (p: { rooms_left?: string[] }) => {
    forgetSettledReads()
    if (!p?.rooms_left?.length) return
    for (const r of p.rooms_left) accessRoomsLeft.add(r)
    later('access', () => {
      const rooms_left = [...accessRoomsLeft]
      accessRoomsLeft.clear()
      window.dispatchEvent(new CustomEvent('nvr:access-changed', { detail: { rooms_left } }))
    })
  })
  socket.on('auth:ok', () => {
    // A new server socket: room counters start over (the reconnect catch-up covers the gap).
    roomGaps.reset()
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
    for (const r of recordHolds.held())
      socket?.emit('record:join', { collection: r.collection, item: r.item })
    // Watch rooms ride the LEADER's socket only (a follower's own socket joining one would keep
    // the server emitting to a tab that never relays it). The leader holds every tab's joins.
    if (!leaderHandle || leaderHandle.isLeader()) {
      for (const room of new Set([...leaderWatchRefs.keys(), ...localWatchRefs.keys()]))
        socket?.emit('admin:join', watchJoinPayload(room))
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
      endRepair()
    }
    everAuthed = true
  })
  // #2450 — the journal position at sign-in: a reconnect replays from here even when no event
  // reached this socket yet (a quiet tab used to have no cursor, so it missed the gap).
  socket.on('catchup:cursor', (p: { seq?: number }) => {
    if (lastSeq === 0 && typeof p?.seq === 'number' && p.seq > 0) lastSeq = p.seq
  })
  socket.on('nvr:ping', (p: { t?: number }) => socket?.emit('nvr:pong', { t: p?.t }))
  // #2475 — on the shared worker's socket the shared adapter (viaWorker) owns room gaps, delivery
  // acks and stale-room refetches; doing them here as well would ask and ack twice per tab.
  const perTab = !usesWorkerSocket()
  socket.onAny((event, payload) => {
    const seq = (payload as { _seq?: number } | undefined)?._seq
    if (typeof seq === 'number' && seq > lastSeq) lastSeq = seq
    if (!perTab) return
    roomGaps.observe(payload)
    recordGaps.observe(event, payload)
    // #2477 — a sampled event asks for its receive time (the delivery SLO's real clients).
    const ack = deliveryAckFor(payload)
    if (ack) socket?.emit('rt:ack', ack)
  })
  if (perTab) {
    socket.on('catchup:room:events', (p: Parameters<typeof roomGaps.replayed>[0]) =>
      roomGaps.replayed(p)
    )
    socket.on('realtime:stale', (p: { rooms?: string[]; all?: boolean }) => {
      const rooms = Array.isArray(p?.rooms) ? p.rooms.filter((r) => typeof r === 'string') : []
      roomGaps.reset(rooms)
      if (p?.all) recordGaps.forget()
      if (p?.all) {
        window.dispatchEvent(new CustomEvent('nvr:catchup-full'))
        window.dispatchEvent(
          new CustomEvent('nvr:realtime-stale', { detail: { rooms, all: true } })
        )
      } else if (rooms.length) refetchRooms(rooms)
    })
  } else {
    // The adapter leaves this window event to getSocket() (viaWorker's windowEvents).
    socket.on('realtime:stale', (p: { all?: boolean }) => {
      if (p?.all) window.dispatchEvent(new CustomEvent('nvr:catchup-full'))
    })
  }
  socket.on(
    'catchup:events',
    (p: {
      events?: Array<{
        seq: number
        event: string
        payload: Record<string, unknown>
        iseq?: number
      }>
    }) => {
      for (const ev of p?.events ?? []) {
        if (ev.seq > lastSeq) lastSeq = ev.seq
        const payload = {
          ...ev.payload,
          _seq: ev.seq,
          ...(typeof ev.iseq === 'number' ? { _iseq: ev.iseq } : {})
        }
        if (perTab) recordGaps.observe(ev.event, payload)
        // Re-dispatch into local listeners (and the leader's feed) as if it arrived live.
        relayLocal(ev.event, payload)
      }
      caughtUp(null, 'replayed')
    }
  )
  socket.on('catchup:full', (p?: { reason?: string }) => {
    // Every list and record reloads: nothing left to judge per record.
    recordGaps.forget()
    later('full', () => window.dispatchEvent(new CustomEvent('nvr:catchup-full')))
    caughtUp(
      p?.reason === 'slow-consumer'
        ? 'Live updates resumed. This tab fell too far behind to send each change, so the lists and records on this page were reloaded.'
        : 'Live updates resumed. The connection was gone too long to replay each change, so the lists and records on this page were reloaded.',
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
  for (const ev of [
    'job:progress',
    'bulk:rows',
    'announcements:changed',
    'flags:changed',
    // rt2 #19 — the people directory moved (pickers, mentions, avatars; ids only).
    'people:changed',
    // rt4 #20 — the person's own lists (saved views, searches, Overview pins) and the shared
    // collection pins moved.
    'mine:changed',
    'pins:changed',
    // rt7 #8 — "Saving 320/500 lines…" for this person's own big save (counts only).
    'save:progress'
  ]) {
    socket.on(ev, (payload: unknown) => relayLiveEvent(ev, payload))
  }
  // A record opened in a drill-down sheet joins its room on THIS socket (adminRealtime.emit
  // below); hand the room's viewer list to the shared presence hook.
  if (!usesWorkerSocket())
    socket.on('record:viewers', (payload: unknown) => relayLiveEvent('record:viewers', payload))
  // Record rooms ride this connection in both modes (use-record-presence joins them here), so the
  // record notices are relayed once here for every record page. `access:changed` reaches the live
  // hooks the same way on a per-tab socket; on the shared one the adapter hands it over.
  // `record:chat` (rt5 #9): a message landed in the record's chat room — unread count re-read.
  for (const ev of [
    'record:integrity',
    'record:automation',
    'owners:changed',
    'record:signal',
    'record:chat',
    // rt7 #9 — a big save is recalculating this record's totals (field names only).
    'record:recalc',
    // rt8 #21 — an AI agent reading or writing the record (names only).
    'record:agents'
  ])
    socket.on(ev, (payload: unknown) => relayLiveEvent(ev, payload))
  if (!usesWorkerSocket())
    socket.on('access:changed', (payload: unknown) => relayLiveEvent('access:changed', payload))
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

/**
 * Record rooms this tab holds, per holder (record-room-holds.ts): the record page
 * (use-record-presence) and the shared presence hook (`usePresence`, e.g. a drill-down sheet or
 * peek of the same record) each hold their own. They ride this tab's own socket (or the shared
 * worker, which keeps every tab's), never the leader's: the room says this tab has the record
 * open, and the leader may be another tab that closes first. A join is always passed on; a
 * leave only when no other holder in this tab still has the record open — closing a peek used
 * to take the page under it out of the room (realtime audit, efp L1). Re-sent on every auth:ok.
 */
const recordHolds = createRecordRoomHolds()

/** Join or leave a record room for one holder of this tab (`payload.holder`, '' = anonymous). */
export function emitRecordRoom(event: 'record:join' | 'record:leave', payload: unknown): void {
  const r = event === 'record:join' ? recordHolds.join(payload) : recordHolds.leave(payload)
  if (!r) return
  const s = getSocket()
  // The shared worker keeps the membership itself (and re-joins after its reconnects).
  if (usesWorkerSocket() || s.connected) s.emit(event, { collection: r.collection, item: r.item })
}

/** Room-bound events that go out and come in on this tab's own socket in leader-tab mode:
 *  record visibility (realtime gaps P1) and chat typing (P2/P10). */
const TAB_SOCKET_EVENTS = new Set(['record:visibility', 'chat:typing'])

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
  'traffic-map:batch',
  'traffic-map:viewer',
  // Flow Run History (#287, rt4 #16): runs and their steps as they land.
  'flow:run',
  'flow:step',
  'lock:requested',
  'lock:response',
  'lock:available',
  'lock:queued',
  'record:uploading',
  // Round 9 #17 — calendar / Gantt drag ghosts (the record's row watchers get them).
  'record:drag',
  'ops:changed',
  'ops:incident',
  'notification:new',
  // C1 — a notification answered elsewhere (owner gap filled, waiting ping answered) comes with
  // no read:changed: the shared bell (useUserSync) re-reads its counts on it in every tab.
  'notification:retired',
  'presence:changed',
  'read:changed',
  'prefs:changed',
  // Send my view: a poke on the person's own room (the card reads the view as them).
  'view:sent',
  // rt4 #20 — a person's own lists and the shared pins, to follower tabs too (the same notice
  // reaching a tab twice inside 150 ms is delivered once by useLiveEvent).
  'mine:changed',
  'pins:changed',
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
        if (s.connected) s.emit('admin:join', watchJoinPayload(r))
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
          roomGaps.reset([`collection:${String(payload)}`])
          recordGaps.forget([String(payload)])
          if (so.connected) so.emit('collection:join', { collection: payload })
          else syncSse()
        } else if (event === '__join_watch') {
          const r = String(payload)
          leaderWatchRefs.set(r, (leaderWatchRefs.get(r) ?? 0) + 1)
          if (so.connected) so.emit('admin:join', watchJoinPayload(r))
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

/**
 * #2475 — with the shared worker the socket is already one per browser and the worker keeps
 * every tab's rooms, so the shared adapter over it is the whole story; the leader-tab relay
 * below is for the per-tab socket.
 */
let workerRealtime: SocketRealtime | null = null
function viaWorker(): SocketRealtime | null {
  if (!usesWorkerSocket()) return null
  if (!workerRealtime)
    workerRealtime = createSocketRealtime({
      socket: () => getSocket() as unknown as SocketLike,
      // getSocket() raises these window events itself.
      windowEvents: {
        catchupFull: false,
        accessChanged: false,
        configUpdate: false,
        forceRefresh: false
      }
    })
  return workerRealtime
}

/** RealtimeAdapter for shared components (CBV patches, RecordLiveSync, MyWork). */
export const adminRealtime: RealtimeAdapter = {
  subscribeCollections(collections, deliver) {
    // Live updates Off (Profile → Display): others' writes stop here for the admin's direct
    // subscribers too (the shared tap filters what reads through the context).
    const cb: typeof deliver = (ev) => {
      if (!liveCollectionEventPasses(ev as never)) return
      // rt5 item 25: admin pages subscribed here time others' saves too (deduped per event).
      noteWriteToScreenEvent(ev)
      deliver(ev)
    }
    const w = viaWorker()
    if (w) return w.subscribeCollections(collections, cb)
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
  on(event, deliver) {
    const cb = (payload: any) => {
      if (
        event === 'collection:update' ? !liveCollectionEventPasses(payload) : liveEventQuiet(event)
      )
        return
      deliver(payload)
    }
    const w = viaWorker()
    if (w) return w.on(event, cb)
    // Chat typing reaches the socket that sits in the chat room: this tab's own
    // (subscribeChatRooms), not the leader's feed.
    if (TAB_SOCKET_EVENTS.has(event)) {
      const s = getSocket()
      s.on(event, cb)
      return () => {
        s.off(event, cb)
      }
    }
    const handle = ensureLeaderSocket()
    return handle.onEvent((ev, payload) => {
      if (ev === event) cb(payload)
    })
  },
  emit(event, payload) {
    // Record rooms first: one tab-wide holds table for the record page and every sheet.
    if (event === 'record:join' || event === 'record:leave') return emitRecordRoom(event, payload)
    const w = viaWorker()
    if (w) return w.emit(event, payload)
    // Said by the socket that sits in the room: the record room (record:join above) or the chat
    // room (subscribeChatRooms) — both ride this tab's own socket, not the leader's.
    if (TAB_SOCKET_EVENTS.has(event)) {
      const s = getSocket()
      if (s.connected) s.emit(event, payload)
      return
    }
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
    return viaWorker()?.status() ?? status
  },
  onStatus(cb) {
    const w = viaWorker()
    if (w) return w.onStatus(cb)
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

/**
 * The `admin:join` payload for a watch room. The Traffic Map page reads `traffic-map:batch`
 * (one delta-encoded batch per second, api traffic-map-batch.ts), so it says so on join; a server
 * without batches ignores the flag and keeps sending `traffic-map:frame`, which the page also
 * reads. Twin: packages/shared socket-realtime.ts (the SharedWorker path).
 */
export function watchJoinPayload(room: string): { room: string; frames?: 'batch' } {
  return room === 'traffic-map' ? { room, frames: 'batch' } : { room }
}

/** Join an admin watch room (traffic/jobs/monitors); returns leave fn. */
export function joinWatchRoom(room: string): () => void {
  const w = viaWorker()
  if (w) return w.joinWatch(room)
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
 *
 * Rooms are reference counted per tab (realtime fixes 2026-11-19): the timeline, a reply
 * thread, pins and read markers each subscribe to the same room, and the server (or the shared
 * worker, per tab) leaves `chat:<room>` on the first `chat:leave`. Closing a thread used to take
 * the open channel off the air. `chat:join` goes out on 0 → 1, `chat:leave` on 1 → 0, and every
 * held room is joined again after each sign-in (`auth:ok`). What was posted while the socket
 * was down is re-read by the live-query bridge's resync (lib/reconnect-resync.ts).
 */
const chatRoomRefs = new Map<string, number>()
let chatRejoinOn: Socket | null = null
function rejoinChatRooms() {
  const s = getSocket()
  for (const room of chatRoomRefs.keys()) s.emit('chat:join', { room })
}

export function subscribeChatRooms<T>(rooms: string[], handler: (msg: T) => void): () => void {
  const s = getSocket()
  if (chatRejoinOn !== s) {
    chatRejoinOn?.off('auth:ok', rejoinChatRooms)
    s.on('auth:ok', rejoinChatRooms)
    chatRejoinOn = s
  }
  const held = [...new Set(rooms.filter(Boolean))]
  for (const room of held) {
    const n = (chatRoomRefs.get(room) ?? 0) + 1
    chatRoomRefs.set(room, n)
    if (n === 1 && s.connected) s.emit('chat:join', { room })
  }
  const listener = (payload: unknown) => handler(payload as T)
  s.on('chat:message', listener)
  let left = false
  return () => {
    if (left) return // a double cleanup must not drop another reader's reference
    left = true
    for (const room of held) {
      const n = (chatRoomRefs.get(room) ?? 1) - 1
      if (n > 0) chatRoomRefs.set(room, n)
      else {
        chatRoomRefs.delete(room)
        s.emit('chat:leave', { room })
      }
    }
    s.off('chat:message', listener)
  }
}

/** Tests only: the chat rooms this tab holds and how many readers each has. */
export function _chatRoomRefsForTests(): Map<string, number> {
  return chatRoomRefs
}
