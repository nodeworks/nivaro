/**
 * Socket chaos (#2463) — the chaos drills (#333, routes/chaos.ts) for live connections. An
 * administrator injects latency, a drop percentage or forced disconnects into the events the
 * server writes to some sockets, for a fixed time, and watches the clients cope: the reconnect
 * banner, the offline outbox and catch-up. Results show on /realtime.
 *
 * Targets: the sockets in one room, one person's sockets, or a share of all signed-in sockets
 * (picked by a stable hash of socket id + drill id). A room drill follows membership live; a
 * person drill follows their new sockets after a reconnect.
 *
 * Faults apply where every packet to a socket passes (the socket plugin's writeToEngine wrapper,
 * `wrapChaosWrite`): `drop_pct` skips that share of packets, `latency_ms` delays every packet by
 * the same amount (order is kept), `disconnect` closes the transport once at the start or every
 * N seconds, so the client sees a dropped connection and reconnects on its own.
 *
 * Time-boxed (5–600 s) and self-healing: when the window ends the wrapper passes straight
 * through again. One drill at a time per cluster. Started on one replica, it reaches every
 * replica through the adapter's server-side emit; each replica keeps its own counters and
 * writes them to Redis every few seconds, the console adds them up.
 *
 * Refused in cloud mode, and when NODE_ENV=production unless CHAOS_ENABLED=true (the flag the
 * HTTP drills already use).
 */
import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { Redis } from 'ioredis'
import type { Socket, Server as SocketIOServer } from 'socket.io'
import { getApp, getIo } from './io-holder.js'
import { eventNameOf, splitTenantRoom } from './socket-transport.js'

export type ChaosTarget =
  | { kind: 'room'; room: string }
  | { kind: 'user'; user_id: string; name?: string | null }
  | { kind: 'share'; share_pct: number }

export interface ChaosFault {
  latency_ms: number
  drop_pct: number
  disconnect: 'none' | 'once' | 'every'
  disconnect_every_s: number
}

export interface ChaosSpec {
  id: string
  target: ChaosTarget
  fault: ChaosFault
  seconds: number
  started_at: number
  ends_at: number
  started_by: string | null
  started_by_name: string | null
}

/** One replica's counters for one drill. */
export interface ChaosCounters {
  node: string
  sockets: number
  users: number
  packets: number
  delayed: number
  dropped: number
  disconnects: number
  /** People whose connection was closed and who came back on a new socket. */
  reconnected: number
  disconnected_users: number
  catchup_requests: number
  catchup_replayed: number
  catchup_full: number
  updated_at: number
}

/** After the window, keep watching this long for reconnects and catch-up answers. */
export const CHAOS_OBSERVE_MS = 60_000
const RUNS_KEY = 'nvr:rt:chaos:runs'
const RUN_KEY = 'nvr:rt:chaos:run:'
const RUN_TTL_S = 7 * 86_400
const RUNS_KEEP = 20
const BROADCAST = 'nvr:rt:chaos'

export class ChaosError extends Error {
  statusCode: number
  constructor(message: string, statusCode = 400) {
    super(message)
    this.statusCode = statusCode
  }
}

/** Why socket chaos may not run in this process, or null (pure). */
export function chaosRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CLOUD_META_DB_URL) return 'Socket chaos never runs in cloud mode'
  if (env.NODE_ENV === 'production' && env.CHAOS_ENABLED !== 'true')
    return 'Socket chaos is refused in production unless CHAOS_ENABLED=true'
  return null
}

const UUID_RE = /^[0-9a-f-]{36}$/i
const ROOM_RE = /^[\w.:@/-]{1,200}$/

/** Checked spec fields from a request body (throws ChaosError naming every bad field). */
export function parseChaosRequest(body: unknown): {
  target: ChaosTarget
  fault: ChaosFault
  seconds: number
} {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const t = (b.target && typeof b.target === 'object' ? b.target : {}) as Record<string, unknown>
  const f = (b.fault && typeof b.fault === 'object' ? b.fault : {}) as Record<string, unknown>
  const bad: string[] = []
  let target: ChaosTarget | null = null
  if (t.kind === 'room') {
    const room = String(t.room ?? '').trim()
    if (!ROOM_RE.test(room)) bad.push('target.room must be a room name')
    else if (/^(session|masq):/.test(room)) bad.push('sign-in rooms cannot be targeted')
    else target = { kind: 'room', room }
  } else if (t.kind === 'user') {
    const id = String(t.user_id ?? '')
    if (!UUID_RE.test(id)) bad.push('target.user_id must be a user id')
    else target = { kind: 'user', user_id: id.toLowerCase() }
  } else if (t.kind === 'share') {
    const pct = Number(t.share_pct)
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100)
      bad.push('target.share_pct must be above 0 and at most 100')
    else target = { kind: 'share', share_pct: pct }
  } else bad.push('target.kind must be room, user or share')

  const num = (v: unknown, lo: number, hi: number, name: string, d: number) => {
    if (v == null || v === '') return d
    const n = Number(v)
    if (!Number.isFinite(n) || n < lo || n > hi) {
      bad.push(`${name} must be between ${lo} and ${hi}`)
      return d
    }
    return n
  }
  const latency = Math.round(num(f.latency_ms, 0, 10_000, 'fault.latency_ms', 0))
  const drop = num(f.drop_pct, 0, 100, 'fault.drop_pct', 0)
  const disconnect = f.disconnect == null || f.disconnect === '' ? 'none' : String(f.disconnect)
  if (!['none', 'once', 'every'].includes(disconnect))
    bad.push('fault.disconnect must be none, once or every')
  const every = Math.round(num(f.disconnect_every_s, 5, 300, 'fault.disconnect_every_s', 30))
  const seconds = Math.round(num(b.seconds, 5, 600, 'seconds', 60))
  if (!bad.length && latency === 0 && drop === 0 && disconnect === 'none')
    bad.push('choose at least one fault: latency, drop or disconnect')
  if (bad.length || !target) throw new ChaosError(bad.join('; ') || 'invalid drill')
  return {
    target,
    fault: {
      latency_ms: latency,
      drop_pct: drop,
      disconnect: disconnect as ChaosFault['disconnect'],
      disconnect_every_s: every
    },
    seconds
  }
}

/** Stable 0–99.99 bucket of a socket within one drill (pure). */
export function shareBucket(socketId: string, drillId: string): number {
  const h = createHash('sha1').update(`${drillId}|${socketId}`).digest()
  return (h.readUInt32BE(0) % 10_000) / 100
}

/** Does this socket fall in the drill (pure, given what the plugin knows about it)? */
export function chaosMatches(
  spec: ChaosSpec,
  s: { id: string; userId: string | null; rooms: Iterable<string> }
): boolean {
  if (spec.target.kind === 'room') {
    const want = spec.target.room
    // Cloud rooms carry a tenant prefix; the drill names the room as the console lists it.
    for (const r of s.rooms) if (splitTenantRoom(r).room === want) return true
    return false
  }
  if (!s.userId) return false
  if (spec.target.kind === 'user') return s.userId.toLowerCase() === spec.target.user_id
  return shareBucket(s.id, spec.id) < spec.target.share_pct
}

// ─── Per-process state ─────────────────────────────────────────────────────────

interface Local {
  spec: ChaosSpec
  sockets: Set<string>
  users: Set<string>
  disconnectedUsers: Map<string, Set<string>>
  reconnectedUsers: Set<string>
  c: Omit<
    ChaosCounters,
    'node' | 'sockets' | 'users' | 'reconnected' | 'disconnected_users' | 'updated_at'
  >
  timers: Array<ReturnType<typeof setTimeout>>
}

let local: Local | null = null
const NODE = `${process.env.NIVARO_INSTANCE?.trim() || process.env.NODE_ENV || 'default'} · ${hostname().slice(0, 40)}`

/** Accessors the socket plugin registers for each socket (user, rooms). */
type Who = { userId: () => string | null }
const who = new Map<string, Who>()

export function chaosActive(now = Date.now()): ChaosSpec | null {
  return local && now < local.spec.ends_at ? local.spec : null
}

function observing(now = Date.now()): boolean {
  return !!local && now < local.spec.ends_at + CHAOS_OBSERVE_MS
}

function redis(): Redis | null {
  try {
    return (getApp()?.redis as Redis | undefined) ?? null
  } catch {
    return null
  }
}

export function chaosCounters(now = Date.now()): ChaosCounters | null {
  if (!local) return null
  return {
    node: NODE,
    sockets: local.sockets.size,
    users: local.users.size,
    ...local.c,
    reconnected: local.reconnectedUsers.size,
    disconnected_users: local.disconnectedUsers.size,
    updated_at: now
  }
}

async function flush(): Promise<void> {
  const r = redis()
  const c = chaosCounters()
  if (!r || !c || !local) return
  try {
    await r
      .multi()
      .hset(`${RUN_KEY}${local.spec.id}:nodes`, NODE, JSON.stringify(c))
      .expire(`${RUN_KEY}${local.spec.id}:nodes`, RUN_TTL_S)
      .exec()
  } catch {
    /* the console shows what reached Redis */
  }
}

function socketsOf(io: SocketIOServer): Socket[] {
  return [...io.of('/').sockets.values()]
}

function matches(spec: ChaosSpec, socket: Socket): boolean {
  return chaosMatches(spec, {
    id: socket.id,
    userId: who.get(socket.id)?.userId() ?? null,
    rooms: socket.rooms
  })
}

function noteTarget(socket: Socket): void {
  if (!local) return
  local.sockets.add(socket.id)
  const u = who.get(socket.id)?.userId()
  if (u) local.users.add(u)
}

function disconnectMatching(io: SocketIOServer): void {
  const spec = chaosActive()
  if (!spec || !local) return
  for (const s of socketsOf(io)) {
    if (!matches(spec, s)) continue
    noteTarget(s)
    const u = who.get(s.id)?.userId()
    if (u) {
      const set = local.disconnectedUsers.get(u) ?? new Set<string>()
      set.add(s.id)
      local.disconnectedUsers.set(u, set)
    }
    local.c.disconnects++
    try {
      // Closing the transport (not socket.disconnect) — the client treats it as a dropped
      // connection and reconnects on its own, which is what the drill is meant to prove.
      ;(s.conn as unknown as { close(): void }).close()
    } catch {
      /* already gone */
    }
  }
}

/** Apply a drill in this process (from the route or another replica's broadcast). */
export function applyChaos(spec: ChaosSpec, io: SocketIOServer | null = getIo()): void {
  stopLocal()
  local = {
    spec,
    sockets: new Set(),
    users: new Set(),
    disconnectedUsers: new Map(),
    reconnectedUsers: new Set(),
    c: {
      packets: 0,
      delayed: 0,
      dropped: 0,
      disconnects: 0,
      catchup_requests: 0,
      catchup_replayed: 0,
      catchup_full: 0
    },
    timers: []
  }
  const l = local
  const now = Date.now()
  if (io) {
    // Count who the drill reaches now; room and share drills keep counting as packets flow.
    for (const s of socketsOf(io)) if (matches(spec, s)) noteTarget(s)
    if (spec.fault.disconnect === 'once') disconnectMatching(io)
    if (spec.fault.disconnect === 'every') {
      const t = setInterval(() => {
        if (!chaosActive()) return clearInterval(t)
        disconnectMatching(io)
      }, spec.fault.disconnect_every_s * 1000)
      t.unref?.()
      l.timers.push(t)
    }
  }
  const tick = setInterval(() => {
    void flush()
    if (local !== l || !observing()) clearInterval(tick)
  }, 5000)
  tick.unref?.()
  l.timers.push(tick)
  const end = setTimeout(() => void flush(), Math.max(0, spec.ends_at + CHAOS_OBSERVE_MS - now))
  end.unref?.()
  l.timers.push(end)
  void flush()
}

function stopLocal(): void {
  if (!local) return
  for (const t of local.timers) clearTimeout(t)
  local.timers = []
}

/** End the drill early here (the counters keep the observation tail). */
export function endChaos(id: string): boolean {
  if (!local || local.spec.id !== id) return false
  const now = Date.now()
  if (now < local.spec.ends_at) local.spec = { ...local.spec, ends_at: now }
  void flush()
  return true
}

let listening = false
/** Hear drills started on other replicas (idempotent). */
export function ensureChaosListener(io: SocketIOServer | null = getIo()): void {
  if (listening || !io) return
  listening = true
  io.on(BROADCAST, (msg: { action?: string; spec?: ChaosSpec; id?: string }) => {
    if (chaosRefusal()) return
    if (msg?.action === 'start' && msg.spec) applyChaos(msg.spec, io)
    else if (msg?.action === 'stop' && msg.id) endChaos(msg.id)
  })
}

// ─── Socket hooks (called by the socket plugin) ────────────────────────────────

/**
 * Wrap one socket's packet write: the drill's faults when it targets this socket, a straight
 * pass otherwise. `write` is the plugin's own per-packet write.
 */
export function wrapChaosWrite(
  socket: Socket,
  write: (p: unknown, opts: Record<string, unknown>) => void,
  userId: () => string | null
): (p: unknown, opts: Record<string, unknown>) => void {
  who.set(socket.id, { userId })
  socket.once('disconnect', () => who.delete(socket.id))
  return (p, opts) => {
    const spec = local ? chaosActive() : null
    if (local && observing() && typeof p === 'string') {
      const ev = eventNameOf(p)
      if (ev === 'catchup:events' || ev === 'catchup:full') {
        const u = userId()
        if (u && local.users.has(u)) {
          if (ev === 'catchup:events') local.c.catchup_replayed++
          else local.c.catchup_full++
        }
      }
    }
    if (!spec || !local || !matches(spec, socket)) return write(p, opts)
    noteTarget(socket)
    local.c.packets++
    if (spec.fault.drop_pct > 0 && Math.random() * 100 < spec.fault.drop_pct) {
      local.c.dropped++
      return
    }
    if (spec.fault.latency_ms > 0) {
      local.c.delayed++
      const t = setTimeout(() => {
        try {
          write(p, opts)
        } catch {
          /* the socket closed meanwhile */
        }
      }, spec.fault.latency_ms)
      t.unref?.()
      return
    }
    write(p, opts)
  }
}

/** Inbound side: a person the drill disrupted, back on a new socket, asking to catch up. */
export function noteChaosInbound(socket: Socket, event: string, userId: string | null): void {
  if (!local || !userId || !observing()) return
  if (event === 'catchup' && local.users.has(userId)) local.c.catchup_requests++
  const closed = local.disconnectedUsers.get(userId)
  if (closed && !closed.has(socket.id)) local.reconnectedUsers.add(userId)
}

// ─── Cluster-wide start / stop / read ──────────────────────────────────────────

export async function startChaos(
  body: unknown,
  by: { id: string | null; name: string | null }
): Promise<ChaosSpec> {
  const refusal = chaosRefusal()
  if (refusal) throw new ChaosError(refusal, 403)
  const req = parseChaosRequest(body)
  const r = redis()
  const now = Date.now()
  if (r) {
    try {
      const newest = await r.lindex(RUNS_KEY, 0)
      if (newest) {
        const raw = await r.get(`${RUN_KEY}${newest}`)
        const prev = raw ? (JSON.parse(raw) as ChaosSpec) : null
        if (prev && prev.ends_at > now)
          throw new ChaosError('A socket drill is already running; stop it first', 409)
      }
    } catch (err) {
      if (err instanceof ChaosError) throw err
    }
  } else if (chaosActive(now)) throw new ChaosError('A socket drill is already running', 409)
  const spec: ChaosSpec = {
    id: randomUUID(),
    ...req,
    started_at: now,
    ends_at: now + req.seconds * 1000,
    started_by: by.id,
    started_by_name: by.name
  }
  if (r) {
    try {
      await r
        .multi()
        .set(`${RUN_KEY}${spec.id}`, JSON.stringify(spec), 'EX', RUN_TTL_S)
        .lpush(RUNS_KEY, spec.id)
        .ltrim(RUNS_KEY, 0, RUNS_KEEP - 1)
        .exec()
    } catch {
      /* this replica still runs it */
    }
  }
  const io = getIo()
  ensureChaosListener(io)
  applyChaos(spec, io)
  try {
    io?.serverSideEmit(BROADCAST, { action: 'start', spec })
  } catch {
    /* single replica or no adapter: this process is the cluster */
  }
  return spec
}

export async function stopChaos(id: string): Promise<boolean> {
  const r = redis()
  let found = endChaos(id)
  if (r) {
    try {
      const raw = await r.get(`${RUN_KEY}${id}`)
      if (raw) {
        const spec = JSON.parse(raw) as ChaosSpec
        if (spec.ends_at > Date.now()) {
          spec.ends_at = Date.now()
          await r.set(`${RUN_KEY}${id}`, JSON.stringify(spec), 'EX', RUN_TTL_S)
        }
        found = true
      }
    } catch {
      /* best effort */
    }
  }
  try {
    getIo()?.serverSideEmit(BROADCAST, { action: 'stop', id })
  } catch {
    /* single replica */
  }
  return found
}

/** Add up the replicas' counters (pure). */
export function sumCounters(rows: ChaosCounters[]): Omit<ChaosCounters, 'node' | 'updated_at'> {
  const out = {
    sockets: 0,
    users: 0,
    packets: 0,
    delayed: 0,
    dropped: 0,
    disconnects: 0,
    reconnected: 0,
    disconnected_users: 0,
    catchup_requests: 0,
    catchup_replayed: 0,
    catchup_full: 0
  }
  for (const r of rows) {
    for (const k of Object.keys(out) as Array<keyof typeof out>) out[k] += Number(r[k]) || 0
  }
  return out
}

export interface ChaosRunView {
  spec: ChaosSpec
  state: 'running' | 'observing' | 'done'
  totals: ReturnType<typeof sumCounters>
  nodes: ChaosCounters[]
}

/** The newest drills with every replica's counters (newest first). */
export async function listChaosRuns(limit = 10): Promise<ChaosRunView[]> {
  const r = redis()
  const now = Date.now()
  const view = (spec: ChaosSpec, nodes: ChaosCounters[]): ChaosRunView => ({
    spec,
    state:
      now < spec.ends_at ? 'running' : now < spec.ends_at + CHAOS_OBSERVE_MS ? 'observing' : 'done',
    totals: sumCounters(nodes),
    nodes
  })
  if (!r) {
    const c = chaosCounters()
    return local && c ? [view(local.spec, [c])] : []
  }
  try {
    const ids = await r.lrange(RUNS_KEY, 0, Math.max(0, limit - 1))
    const out: ChaosRunView[] = []
    for (const id of ids) {
      const raw = await r.get(`${RUN_KEY}${id}`)
      if (!raw) continue
      const spec = JSON.parse(raw) as ChaosSpec
      const hash = (await r.hgetall(`${RUN_KEY}${id}:nodes`)) ?? {}
      const nodes: ChaosCounters[] = []
      for (const v of Object.values(hash)) {
        try {
          nodes.push(JSON.parse(v) as ChaosCounters)
        } catch {
          /* skip */
        }
      }
      out.push(view(spec, nodes))
    }
    return out
  } catch {
    return []
  }
}

/** Tests only. */
export function _resetChaosForTests(): void {
  stopLocal()
  local = null
  who.clear()
  listening = false
}
