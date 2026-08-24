import { createLeaderSocket, type RealtimeAdapter } from '@nivaro/shared'
import { io, type Socket } from 'socket.io-client'
import { api } from '@/lib/api'

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
 */

const API_URL = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3055'

let socket: Socket | null = null
let reconnects = -1
let lastSeq = 0
let everAuthed = false

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
    transports: ['websocket', 'polling'],
    withCredentials: true,
    reconnection: true,
    // Reconnect jitter (#332): after an API restart every open tab reconnects
    // at once — randomized backoff spreads the stampede over a window.
    reconnectionDelay: 1500 + Math.floor(Math.random() * 2500),
    reconnectionDelayMax: 15_000,
    randomizationFactor: 0.6
  })
  socket.on('connect', () => {
    reconnects += 1
    void authToken().then((token) => {
      if (token) socket?.emit('auth', { token })
    })
  })
  socket.on('auth:ok', () => {
    socket?.emit('client:hello', { reconnects: Math.max(0, reconnects), app: 'admin' })
    // Rejoin what this tab holds, then replay whatever happened while away.
    for (const room of joinedCollections) socket?.emit('collection:join', { collection: room })
    for (const room of joinedWatchRooms) socket?.emit('admin:join', { room })
    if (everAuthed && lastSeq > 0) {
      const cursor = lastSeq
      setTimeout(() => socket?.emit('catchup', { cursor }), Math.random() * 2000)
    }
    everAuthed = true
  })
  socket.on('nvr:ping', (p: { t?: number }) => socket?.emit('nvr:pong', { t: p?.t }))
  socket.onAny((_event, payload) => {
    const seq = (payload as { _seq?: number } | undefined)?._seq
    if (typeof seq === 'number' && seq > lastSeq) lastSeq = seq
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
    }
  )
  socket.on('catchup:full', () => {
    window.dispatchEvent(new CustomEvent('nvr:catchup-full'))
  })
  socket.on('client:force-refresh', (p: { seconds?: number; message?: string }) => {
    window.dispatchEvent(new CustomEvent('nvr:force-refresh', { detail: p ?? {} }))
  })
  return socket
}

// ── Collection feed via leader election ─────────────────────────────────────
// Only the LEADER tab joins collection rooms + relays events to followers.
// joinedCollections tracks bare collection names the leader must be in.
const joinedCollections = new Set<string>()
const joinedWatchRooms = new Set<string>()

const RELAYED_EVENTS = new Set([
  'collection:update',
  'job:update',
  'monitor:status',
  'traffic:request',
  'lock:requested',
  'lock:response',
  'record:uploading'
])

let leaderHandle: ReturnType<typeof createLeaderSocket> | null = null

function ensureLeaderSocket() {
  if (leaderHandle) return leaderHandle
  leaderHandle = createLeaderSocket('admin-feed', {
    becomeLeader(deliver, emitRef) {
      const s = getSocket()
      for (const c of joinedCollections) {
        if (s.connected) s.emit('collection:join', { collection: c })
      }
      for (const r of joinedWatchRooms) {
        if (s.connected) s.emit('admin:join', { room: r })
      }
      s.onAny((event, payload) => {
        if (RELAYED_EVENTS.has(event)) deliver(event, payload)
      })
      emitRef.current = (event, payload) => {
        const so = getSocket()
        if (event === '__join_collection') {
          joinedCollections.add(String(payload))
          if (so.connected) so.emit('collection:join', { collection: payload })
        } else if (event === '__join_watch') {
          joinedWatchRooms.add(String(payload))
          if (so.connected) so.emit('admin:join', { room: payload })
        } else if (event === '__leave_watch') {
          joinedWatchRooms.delete(String(payload))
          if (so.connected) so.emit('admin:leave', { room: payload })
        } else {
          so.emit(event, payload)
        }
      }
    },
    resignLeader() {
      // The socket stays up for chat; we just stop being the feed source.
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
    ensureLeaderSocket().emit(event, payload)
  }
}

/** Join an admin watch room (traffic/jobs/monitors); returns leave fn. */
export function joinWatchRoom(room: string): () => void {
  const handle = ensureLeaderSocket()
  joinedWatchRooms.add(room)
  handle.emit('__join_watch', room)
  return () => {
    joinedWatchRooms.delete(room)
    handle.emit('__leave_watch', room)
  }
}

/** Subscribe to live updates for a collection; returns an unsubscribe. */
export function onCollectionUpdate(
  collection: string,
  handler: (payload?: { collection?: string; item?: string | number }) => void
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
