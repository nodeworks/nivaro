// A socket.io client that behaves like the shipped one (packages/shared/src/lib/socket-realtime.ts):
// a fresh one-time ws-token on every connect, `auth`, `client:hello`, every held room joined again
// after each `auth:ok`, `catchup {cursor}` after a reconnect (cursor = the highest `_seq` seen or
// the server's `catchup:cursor`), catch-up events replayed into the same log, and `rt:ack` for
// sampled events. Every inbound event is recorded with its receive time.
import { cfg, io } from './config.mjs'

let nextId = 1

export class LiveSocket {
  /**
   * @param {import('./http.mjs').Client} client  signs the socket in (ws-token) — or null with `staticToken`
   * @param {object} [o]
   * @param {string} [o.base]                 entry URL (default Traefik v3)
   * @param {string[]} [o.transports]         ['websocket'] | ['polling'] | ['polling','websocket']
   * @param {string} [o.staticToken]          sign in with a static token instead of a ws-token
   * @param {boolean} [o.reconnection]
   * @param {string[]} [o.features]           client:hello features (default coalesce off)
   * @param {boolean} [o.sharedWorker]        client:hello shared_worker: true
   * @param {boolean} [o.ack]                 answer sampled events with rt:ack (default true)
   * @param {boolean} [o.catchup]             send `catchup` after a reconnect (default true)
   */
  constructor(client, o = {}) {
    this.id = nextId++
    this.client = client
    this.o = { transports: ['websocket'], reconnection: true, ack: true, catchup: true, ...o }
    this.base = (o.base ?? client?.base ?? cfg.base).replace(/\/$/, '')
    /** @type {{ ev: string, p: any, at: number, replay?: boolean }[]} */
    this.events = []
    /** @type {[string, any][]} */
    this.joins = []
    this.lastSeq = 0
    this.authCount = 0
    this.connects = 0
    this.disconnects = []
    this.connectErrors = []
    this.authFailures = []
    this.userId = null
    this.waiters = new Set()
    this.closed = false
    /** Per-room counters for gap detection; gaps seen and room catch-ups answered. */
    this.rooms = new Map()
    this.roomGaps = []
    this.roomCatchups = []
  }

  /** Connect and wait for auth:ok (resolves with this). */
  async open({ timeoutMs = 15_000 } = {}) {
    // No session cookie on the socket: like a browser on another origin, it signs in with the
    // ws-token. The engine's own cookie jar (withCredentials) keeps Traefik's sticky cookie.
    const extraHeaders = {
      'user-agent': `rtci-socket/${this.id}`,
      ...(this.client?.extraHeaders ?? {}),
      ...(this.o.extraHeaders ?? {})
    }
    this.s = io(this.base, {
      path: '/socket.io/',
      transports: this.o.transports,
      reconnection: this.o.reconnection,
      reconnectionDelay: 300,
      reconnectionDelayMax: 2000,
      randomizationFactor: 0.3,
      timeout: 10_000,
      withCredentials: true,
      extraHeaders,
      forceNew: true
    })
    const s = this.s
    s.on('connect', () => {
      this.connects++
      void this.authenticate()
    })
    s.on('disconnect', (reason) => this.disconnects.push({ reason, at: Date.now() }))
    s.on('connect_error', (err) => this.connectErrors.push({ message: err?.message, at: Date.now() }))
    s.on('auth:ok', (p) => {
      this.userId = p?.userId ?? null
      this.rooms.clear() // a new server socket: room counters start over
      const reconnect = this.authCount > 0
      this.authCount++
      for (const [ev, payload] of this.joins) s.emit(ev, payload)
      // The shipped client sends `catchup` right after the rejoins (catchupDelayMs 0); a delay
      // lets the suites tell a rejoin/catch-up race from a journal that lacks the events.
      const cursor = this.lastSeq
      if (reconnect && this.o.catchup && cursor > 0) {
        const delay = this.o.catchupDelayMs ?? Number(process.env.RTCI_CATCHUP_DELAY_MS ?? 0)
        if (delay > 0) setTimeout(() => s.emit('catchup', { cursor }), delay)
        else s.emit('catchup', { cursor })
      }
    })
    s.on('catchup:cursor', (p) => {
      if (this.lastSeq === 0 && typeof p?.seq === 'number') this.lastSeq = p.seq
    })
    s.on('catchup:events', (p) => {
      for (const e of p?.events ?? []) {
        if (typeof e.seq === 'number' && e.seq > this.lastSeq) this.lastSeq = e.seq
        this.record(e.event, { ...e.payload, _seq: e.seq }, true)
      }
    })
    s.on('nvr:ping', (p) => s.emit('nvr:pong', p))
    // #2462, like packages/shared/src/lib/room-gaps.ts (simplified): a room counter (_rseq) that
    // skips while connected → after a 1.5 s grace, `catchup:room` for that room alone.
    s.on('catchup:room:events', (p) => {
      this.roomCatchups.push({ room: p?.room, full: !!p?.full, n: p?.events?.length ?? 0, at: Date.now() })
      for (const e of p?.events ?? []) {
        if (typeof e.seq === 'number' && e.seq > this.lastSeq) this.lastSeq = e.seq
        this.record(e.event, { ...e.payload, _seq: e.seq }, true)
      }
    })
    s.onAny((ev, p) => {
      if (this.o.roomGaps !== false) this.observeRoom(p)
      const seq = p?._seq
      if (typeof seq === 'number' && seq > this.lastSeq) this.lastSeq = seq
      if (this.o.ack && typeof p?._seq === 'number' && typeof p?._st === 'number')
        s.emit('rt:ack', { seq: p._seq, st: p._st, rx: Date.now() })
      this.record(ev, p, false)
    })
    await this.waitAuth(timeoutMs)
    return this
  }

  async authenticate(attempt = 0) {
    try {
      const token = this.o.staticToken ?? (await this.client.wsToken())
      this.s.emit('client:hello', {
        app: 'rtci',
        reconnects: Math.max(0, this.connects - 1),
        features: this.o.features ?? [],
        shared_worker: this.o.sharedWorker === true,
        build: 'rtci',
        tab: `rtci-${this.id}`,
        // Per-socket overrides: { app, build, api, tab, loaded } — sticky refresh / min-build tests.
        ...(this.o.hello ?? {})
      })
      this.s.emit('auth', { token })
    } catch (e) {
      this.authFailures.push({ message: e.message, status: e.status, at: Date.now() })
      // A ws-token request can land on a web process that is going away (a replica loss in
      // single-role mode): retry with backoff while the socket is up, like a real tab would on
      // its next reconnect. A 401/403 is final.
      if (e.status !== 401 && e.status !== 403 && attempt < 6 && this.s?.connected && !this.closed)
        setTimeout(() => void this.authenticate(attempt + 1), 300 * 2 ** attempt)
    }
  }

  observeRoom(p) {
    if (!p || typeof p._room !== 'string' || typeof p._rseq !== 'number') return
    const room = p._room
    const hi = p._rseq
    const lo = typeof p._rseq_min === 'number' ? p._rseq_min : hi
    const seq = typeof p._seq === 'number' ? p._seq : 0
    const st = this.rooms.get(room)
    if (!st || hi < st.rseq) {
      this.rooms.set(room, { rseq: hi, seq })
      return
    }
    if (lo > st.rseq + 1) {
      const cursor = st.seq
      const missed = lo - st.rseq - 1
      this.roomGaps.push({ room, missed, at: Date.now() })
      setTimeout(() => {
        if (this.s?.connected) this.s.emit('catchup:room', { room, cursor, missed })
      }, 1500)
    }
    if (hi > st.rseq) this.rooms.set(room, { rseq: hi, seq: Math.max(st.seq, seq) })
  }

  waitAuth(timeoutMs = 15_000) {
    const want = this.authCount + 1
    return this.until(() => this.authCount >= want, timeoutMs, 'auth:ok')
  }

  record(ev, p, replay) {
    const e = { ev, p, at: Date.now(), replay }
    this.events.push(e)
    for (const w of this.waiters) w()
  }

  /** Join a room now and after every reconnect (like the shipped client's held topics). */
  join(ev, payload) {
    this.joins.push([ev, payload])
    this.s.emit(ev, payload)
  }

  leave(ev, payload, joinEv) {
    this.joins = this.joins.filter(
      ([e, p]) => !(e === joinEv && JSON.stringify(p) === JSON.stringify(payload))
    )
    this.s.emit(ev, payload)
  }

  emit(ev, ...args) {
    this.s.emit(ev, ...args)
  }

  /** Resolve when pred() is true (re-checked on every event), reject after timeoutMs. */
  until(pred, timeoutMs, label = 'condition') {
    return new Promise((resolve, reject) => {
      if (pred()) return resolve(true)
      const check = () => {
        if (pred()) {
          clearTimeout(t)
          clearInterval(iv)
          this.waiters.delete(check)
          resolve(true)
        }
      }
      const t = setTimeout(() => {
        clearInterval(iv)
        this.waiters.delete(check)
        reject(new Error(`socket#${this.id}: no ${label} within ${timeoutMs} ms`))
      }, timeoutMs)
      const iv = setInterval(check, 100)
      this.waiters.add(check)
    })
  }

  /** The first event named `ev` after index `from` matching `pred` (or null after timeoutMs). */
  async next(ev, pred = () => true, { timeoutMs = 8000, from = 0 } = {}) {
    const find = () => this.events.slice(from).find((e) => e.ev === ev && pred(e.p))
    try {
      await this.until(() => !!find(), timeoutMs, ev)
      return find()
    } catch {
      return null
    }
  }

  /** Events named `ev` (after index `from`). */
  all(ev, from = 0) {
    return this.events.slice(from).filter((e) => e.ev === ev)
  }

  mark() {
    return this.events.length
  }

  get connected() {
    return !!this.s?.connected
  }

  get transport() {
    return this.s?.io?.engine?.transport?.name ?? null
  }

  /** emitWithAck with a timeout (null when nothing answered). */
  async ask(ev, payload, timeoutMs = 5000) {
    try {
      return await this.s.timeout(timeoutMs).emitWithAck(ev, payload)
    } catch {
      return null
    }
  }

  close() {
    this.closed = true
    this.s?.disconnect()
    this.s?.close?.()
  }
}

export async function openSockets(clients, o = {}, { concurrency = 25 } = {}) {
  const out = []
  let i = 0
  async function worker() {
    while (i < clients.length) {
      const c = clients[i++]
      out.push(await new LiveSocket(c, o).open())
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, clients.length) }, worker))
  return out
}

export function closeAll(socks) {
  for (const s of socks) s?.close()
}
