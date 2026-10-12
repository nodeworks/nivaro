import type { CollectionUpdateEvent, RealtimeAdapter, RealtimeStatus } from './realtime'

/**
 * A RealtimeAdapter over one Socket.io connection the HOST already holds (#2027, #1751) — what a
 * portal or headless frontend mounts in `RealtimeContext` so every shared live surface (lists,
 * record pages, My Work, Notes, tasks, ops pages, the @nivaro/react live hooks) works there the
 * way it does in the admin app, without per-app socket wiring.
 *
 *   const realtime = createSocketRealtime({ socket: () => getSocket() })
 *   <RealtimeContext.Provider value={realtime}>…</RealtimeContext.Provider>
 *
 * The host keeps owning the connection: it creates the socket, sends `auth {token}` on connect
 * and its `client:hello`. The adapter owns everything room-shaped on top of it:
 *
 * - `collection:join` / `collection:leave`, reference counted per collection;
 *   `admin:join` (watch rooms) and `ops:join` (live operations topics) likewise.
 * - Every held room is joined again after each `auth:ok` (a reconnect is a new server socket).
 * - Missed-event catch-up: events carry `_seq`; after a reconnect the adapter sends its cursor
 *   (`catchup {cursor}`), replays `catchup:events` into the same listeners, and turns a
 *   `catchup:full` (the journal no longer covers the gap) into the `nvr:catchup-full` window event
 *   lists and records already reload on.
 * - `access:changed` with rooms taken away → `nvr:access-changed`; `config:update` →
 *   `nvr:config-update`; `client:force-refresh` → `nvr:force-refresh` (the window events admin's
 *   socket raises, so shared banners and forms behave the same in every host).
 * - Connection state for the reconnect banner and stale marks (`status` / `onStatus`).
 *
 * The socket is duck-typed (socket.io-client's `Socket` fits), so this package takes no
 * dependency on socket.io-client. It never decides what a viewer may see: every room is gated by
 * the server at join time, and payloads carry ids and field names only.
 */

/** The slice of a socket.io-client `Socket` the adapter uses. */
export interface SocketLike {
  connected: boolean
  on(event: string, cb: (...args: any[]) => void): unknown
  off(event: string, cb?: (...args: any[]) => void): unknown
  emit(event: string, ...args: any[]): unknown
  onAny?(cb: (event: string, ...args: any[]) => void): unknown
  listeners?(event: string): Array<(...args: any[]) => void>
  io?: { engine?: { transport?: { name?: string } } }
}

export type SocketRealtimeWindowEvent =
  | 'catchupFull'
  | 'accessChanged'
  | 'configUpdate'
  | 'forceRefresh'

export interface SocketRealtimeOptions {
  /** The host's socket, or a getter (called lazily, on the first subscription). */
  socket: SocketLike | (() => SocketLike)
  /**
   * Window events to raise from socket events (all on by default). Turn one off when the host
   * already raises it itself, so a banner does not run twice.
   */
  windowEvents?: Partial<Record<SocketRealtimeWindowEvent, boolean>>
  /** How long a reconnect waits for its catch-up answer before it counts as live again. */
  catchupTimeoutMs?: number
}

const WINDOW_EVENT_NAMES: Record<SocketRealtimeWindowEvent, string> = {
  catchupFull: 'nvr:catchup-full',
  accessChanged: 'nvr:access-changed',
  configUpdate: 'nvr:config-update',
  forceRefresh: 'nvr:force-refresh'
}

/** One reference-counted set of server rooms (join on the first holder, leave after the last). */
class RoomRefs {
  private refs = new Map<string, number>()
  constructor(
    private readonly join: (key: string) => void,
    private readonly leave: (key: string) => void
  ) {}
  add(key: string): void {
    const n = this.refs.get(key) ?? 0
    this.refs.set(key, n + 1)
    if (n === 0) this.join(key)
  }
  remove(key: string): void {
    const n = this.refs.get(key) ?? 0
    if (n <= 0) return
    if (n === 1) {
      this.refs.delete(key)
      this.leave(key)
    } else this.refs.set(key, n - 1)
  }
  rejoinAll(): void {
    for (const key of this.refs.keys()) this.join(key)
  }
  keys(): string[] {
    return [...this.refs.keys()]
  }
}

export interface SocketRealtime extends RealtimeAdapter {
  status(): RealtimeStatus
  onStatus(cb: (s: RealtimeStatus) => void): () => void
  joinWatch(room: string): () => void
  /** Collections, watch rooms and ops topics currently held (for diagnostics and tests). */
  held(): { collections: string[]; watch: string[]; ops: string[] }
}

export function createSocketRealtime(opts: SocketRealtimeOptions): SocketRealtime {
  let socket: SocketLike | null = null
  let lastSeq = 0
  let everAuthed = false
  let catchupTimer: ReturnType<typeof setTimeout> | null = null
  let status: RealtimeStatus = { state: 'live', transport: null, refreshed: null }
  const statusListeners = new Set<(s: RealtimeStatus) => void>()
  const windowOn = (k: SocketRealtimeWindowEvent) => opts.windowEvents?.[k] !== false

  const setStatus = (patch: Partial<RealtimeStatus>) => {
    const next = { ...status, ...patch }
    if (
      next.state === status.state &&
      next.transport === status.transport &&
      next.refreshed === status.refreshed
    )
      return
    status = next
    for (const l of statusListeners) l(status)
  }
  const transportName = (): RealtimeStatus['transport'] =>
    (socket?.io?.engine?.transport?.name as RealtimeStatus['transport'] | undefined) ?? null
  const caughtUp = (refreshed: string | null) => {
    if (catchupTimer) clearTimeout(catchupTimer)
    catchupTimer = null
    setStatus({ state: 'live', transport: transportName(), refreshed })
  }
  const dispatch = (name: string, detail: unknown) => {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent(name, { detail }))
  }
  const send = (event: string, payload: unknown) => {
    if (socket?.connected) socket.emit(event, payload)
  }

  const collections = new RoomRefs(
    (c) => send('collection:join', { collection: c }),
    (c) => send('collection:leave', { collection: c })
  )
  const watch = new RoomRefs(
    (r) => send('admin:join', { room: r }),
    (r) => send('admin:leave', { room: r })
  )
  const ops = new RoomRefs(
    (t) => send('ops:join', { topic: t }),
    (t) => send('ops:leave', { topic: t })
  )

  const ensure = (): SocketLike => {
    if (socket) return socket
    const s = typeof opts.socket === 'function' ? opts.socket() : opts.socket
    socket = s
    // Attached to a socket that is already up: its next auth:ok is a reconnect (catch up).
    everAuthed = s.connected
    s.on('auth:ok', () => {
      collections.rejoinAll()
      watch.rejoinAll()
      ops.rejoinAll()
      if (everAuthed && lastSeq > 0) {
        const cursor = lastSeq
        setStatus({ transport: transportName() })
        if (catchupTimer) clearTimeout(catchupTimer)
        catchupTimer = setTimeout(() => caughtUp(null), opts.catchupTimeoutMs ?? 8000)
        s.emit('catchup', { cursor })
      } else {
        setStatus({ state: 'live', transport: transportName(), refreshed: null })
      }
      everAuthed = true
    })
    s.on('disconnect', () => {
      if (catchupTimer) clearTimeout(catchupTimer)
      catchupTimer = null
      setStatus({ state: 'reconnecting', refreshed: null })
    })
    s.on('connect_error', () => setStatus({ state: 'reconnecting', refreshed: null }))
    s.onAny?.((_event, payload) => {
      const seq = (payload as { _seq?: number } | undefined)?._seq
      if (typeof seq === 'number' && seq > lastSeq) lastSeq = seq
    })
    s.on(
      'catchup:events',
      (p: { events?: Array<{ seq: number; event: string; payload: Record<string, unknown> }> }) => {
        for (const ev of p?.events ?? []) {
          if (ev.seq > lastSeq) lastSeq = ev.seq
          // Into the same listeners, as if it had arrived live.
          for (const l of s.listeners?.(ev.event) ?? []) l({ ...ev.payload, _seq: ev.seq })
        }
        caughtUp(null)
      }
    )
    s.on('catchup:full', () => {
      if (windowOn('catchupFull')) dispatch(WINDOW_EVENT_NAMES.catchupFull, {})
      caughtUp(
        'Live updates resumed. The connection was gone too long to replay each change, so the lists and records on this page were reloaded.'
      )
    })
    s.on('access:changed', (p: { rooms_left?: string[] }) => {
      if (p?.rooms_left?.length && windowOn('accessChanged'))
        dispatch(WINDOW_EVENT_NAMES.accessChanged, p)
    })
    s.on('config:update', (p: unknown) => {
      if (windowOn('configUpdate')) dispatch(WINDOW_EVENT_NAMES.configUpdate, p ?? {})
    })
    s.on('client:force-refresh', (p: unknown) => {
      if (windowOn('forceRefresh')) dispatch(WINDOW_EVENT_NAMES.forceRefresh, p ?? {})
    })
    return s
  }

  return {
    subscribeCollections(names, cb) {
      const s = ensure()
      const list = [...new Set(names.filter(Boolean))]
      for (const c of list) collections.add(c)
      const listener = (p: CollectionUpdateEvent) => {
        if (p?.collection && list.includes(p.collection)) cb(p)
      }
      s.on('collection:update', listener)
      let done = false
      return () => {
        if (done) return
        done = true
        s.off('collection:update', listener)
        for (const c of list) collections.remove(c)
      }
    },
    on(event, cb) {
      const s = ensure()
      s.on(event, cb)
      return () => {
        s.off(event, cb)
      }
    },
    emit(event, payload) {
      ensure()
      // Topic joins are reference counted and sent again after every reconnect.
      if (event === 'ops:join' || event === 'ops:leave') {
        const topic = String((payload as { topic?: string } | undefined)?.topic ?? '')
        if (!topic) return
        if (event === 'ops:join') ops.add(topic)
        else ops.remove(topic)
        return
      }
      socket?.emit(event, payload)
    },
    status() {
      return status
    },
    onStatus(cb) {
      ensure()
      statusListeners.add(cb)
      return () => {
        statusListeners.delete(cb)
      }
    },
    joinWatch(room) {
      ensure()
      watch.add(room)
      let left = false
      return () => {
        if (left) return // a double cleanup must not drop another watcher's reference
        left = true
        watch.remove(room)
      }
    },
    held() {
      return { collections: collections.keys(), watch: watch.keys(), ops: ops.keys() }
    }
  }
}
