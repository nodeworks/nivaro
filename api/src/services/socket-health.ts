import type { Redis } from 'ioredis'
import { INSTANCE_ID } from './instance-roster.js'
import {
  encodeEvent,
  eventNameOf,
  isCredentialRoom,
  roomKind,
  splitTenantRoom
} from './socket-transport.js'

/**
 * Socket health (#2460 slow consumers, #2488 write buffers, #2779 handler timings, #2462 room
 * gaps). Everything is measured per API process and every process publishes its figures to
 * Redis (`nvr:rt:health:<instance>`, 30 s TTL, every 10 s), so the Realtime console shows the
 * whole deployment, not the replica that answered.
 *
 * - Slow consumers: each socket's waiting bytes = the engine.io write buffer (packets created but
 *   not yet handed to the transport) + the websocket's own `bufferedAmount`. Over the SOFT limit
 *   the socket stops getting room broadcasts and remembers which rooms changed; once it has caught
 *   up it gets ONE `realtime:stale {rooms}` and refetches those. Past the HARD limit it is closed,
 *   its backlog dropped, and its tab gets a full resync when it reconnects.
 * - Buffer report: the sockets with the most bytes waiting, the biggest rooms and the total
 *   waiting bytes over the last ten minutes.
 * - Handler timings: how long each inbound socket event handler took (total, and the part that
 *   held the event loop), as mergeable histograms; p50/p95 and the slowest recent calls.
 * - Room gaps: how many times a connected client spotted a dropped event in one room and caught
 *   that room up.
 *
 * Counters are kept per scope: '' self-hosted; in cloud mode one per tenant, so one tenant's
 * console never names another tenant's people or rooms.
 */

const DEFAULT_SOFT = 1024 * 1024
const DEFAULT_HARD = 8 * 1024 * 1024

/** SOCKET_BUFFER_SOFT_BYTES / SOCKET_BUFFER_HARD_BYTES (defaults 1 MiB / 8 MiB). */
export function bufferLimits(): { soft: number; hard: number } {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : d
  }
  const soft = num(process.env.SOCKET_BUFFER_SOFT_BYTES, DEFAULT_SOFT)
  let hard = num(process.env.SOCKET_BUFFER_HARD_BYTES, DEFAULT_HARD)
  if (hard <= soft) hard = soft * 4
  return { soft, hard }
}

// ── Scopes ──────────────────────────────────────────────────────────────────

export const HIST_BOUNDS = [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000]

export interface HandlerStat {
  count: number
  /** One count per HIST_BOUNDS bucket (ms upper bound) plus a last "slower" bucket. */
  hist: number[]
  total: number
  max: number
  /** Longest part of one call that ran before the handler returned (held the event loop). */
  sync_max: number
}

export interface SlowCall {
  handler: string
  ms: number
  sync_ms: number
  at: string
}

export interface Disconnect {
  at: string
  user: string | null
  app: string | null
  waiting: number
}

interface GapStat {
  reports: number
  missed: number
  replayed: number
  full: number
  by_kind: Map<string, { reports: number; missed: number }>
}

interface Scope {
  softEntered: number
  hardDisconnects: number
  staleSent: number
  suppressed: number
  disconnects: Disconnect[]
  /** Epoch minute → handler → stat; the last WINDOW_MIN minutes. */
  minutes: Map<number, Map<string, HandlerStat>>
  slowest: SlowCall[]
  gaps: GapStat
  growth: GrowthPoint[]
}

export interface GrowthPoint {
  /** Sample time, aligned to SAMPLE_MS so replicas' points line up. */
  t: number
  total: number
  max: number
}

const WINDOW_MIN = 10
const SLOWEST = 20
export const SAMPLE_MS = 10_000
const GROWTH_POINTS = (WINDOW_MIN * 60_000) / SAMPLE_MS
const scopes = new Map<string, Scope>()

function scopeOf(tenant: string | null | undefined): Scope {
  const key = tenant ?? ''
  let s = scopes.get(key)
  if (!s) {
    s = {
      softEntered: 0,
      hardDisconnects: 0,
      staleSent: 0,
      suppressed: 0,
      disconnects: [],
      minutes: new Map(),
      slowest: [],
      gaps: { reports: 0, missed: 0, replayed: 0, full: 0, by_kind: new Map() },
      growth: []
    }
    scopes.set(key, s)
  }
  return s
}

export function resetSocketHealth(): void {
  scopes.clear()
  tracked.clear()
}

// ── Handler timings (#2779) ─────────────────────────────────────────────────

function emptyStat(): HandlerStat {
  return {
    count: 0,
    hist: new Array(HIST_BOUNDS.length + 1).fill(0),
    total: 0,
    max: 0,
    sync_max: 0
  }
}

function bucketOf(ms: number): number {
  for (let i = 0; i < HIST_BOUNDS.length; i++) if (ms <= HIST_BOUNDS[i]) return i
  return HIST_BOUNDS.length
}

/** One handler call finished. `syncMs` = the part before it returned (its promise, if any). */
export function noteHandler(
  tenant: string | null,
  handler: string,
  ms: number,
  syncMs: number,
  now = Date.now()
): void {
  const s = scopeOf(tenant)
  const minute = Math.floor(now / 60_000)
  let m = s.minutes.get(minute)
  if (!m) {
    m = new Map()
    s.minutes.set(minute, m)
    for (const k of s.minutes.keys()) if (k <= minute - WINDOW_MIN) s.minutes.delete(k)
  }
  let st = m.get(handler)
  if (!st) {
    if (m.size >= 200) handler = 'other'
    st = m.get(handler) ?? emptyStat()
    m.set(handler, st)
  }
  st.count++
  st.hist[bucketOf(ms)]++
  st.total += ms
  if (ms > st.max) st.max = ms
  if (syncMs > st.sync_max) st.sync_max = syncMs
  const floor = s.slowest.length < SLOWEST ? -1 : s.slowest[s.slowest.length - 1].ms
  if (ms > floor) {
    s.slowest.push({
      handler,
      ms: round(ms),
      sync_ms: round(syncMs),
      at: new Date(now).toISOString()
    })
    s.slowest.sort((a, b) => b.ms - a.ms)
    if (s.slowest.length > SLOWEST) s.slowest.length = SLOWEST
  }
  // The slowest list is "recent": calls older than the window fall off.
  const cutoff = now - WINDOW_MIN * 60_000
  if (s.slowest.length && Date.parse(s.slowest[s.slowest.length - 1].at) < cutoff)
    s.slowest = s.slowest.filter((c) => Date.parse(c.at) >= cutoff)
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

function mergeStat(into: HandlerStat, from: HandlerStat): void {
  into.count += from.count
  for (let i = 0; i < into.hist.length; i++) into.hist[i] += from.hist[i] ?? 0
  into.total += from.total
  into.max = Math.max(into.max, from.max)
  into.sync_max = Math.max(into.sync_max, from.sync_max)
}

/** The value at quantile `q` (0–1) of a bucket histogram, interpolated inside its bucket. */
export function histQuantile(hist: number[], q: number, max: number): number {
  const total = hist.reduce((a, b) => a + b, 0)
  if (total === 0) return 0
  const target = q * total
  let seen = 0
  for (let i = 0; i < hist.length; i++) {
    if (hist[i] === 0) continue
    if (seen + hist[i] >= target) {
      const lo = i === 0 ? 0 : HIST_BOUNDS[i - 1]
      const hi = i < HIST_BOUNDS.length ? HIST_BOUNDS[i] : Math.max(max, lo)
      const v = lo + ((target - seen) / hist[i]) * (hi - lo)
      return round(Math.min(v, max || v))
    }
    seen += hist[i]
  }
  return round(max)
}

const RESERVED = new Set(['disconnect', 'disconnecting', 'error', 'newListener', 'removeListener'])

type Listener = (...args: any[]) => unknown

/**
 * Time every inbound event handler registered on this socket from now on (call it before the
 * first `socket.on`). `off`/`removeListener` keep working with the original function.
 */
export function instrumentHandlers(
  socket: {
    id: string
    on(event: string, fn: Listener): unknown
    off?(event: string, fn: Listener): unknown
    removeListener?(event: string, fn: Listener): unknown
  },
  tenant: () => string | null,
  onCall?: (handler: string, ms: number) => void
): void {
  const wrapped = new WeakMap<Listener, Listener>()
  const origOn = socket.on.bind(socket)
  const finish = (event: string, t0: number, syncMs: number) => {
    const ms = performance.now() - t0
    try {
      noteHandler(tenant(), event, ms, syncMs)
      onCall?.(event, ms)
    } catch {
      /* a diagnostic never affects the handler */
    }
  }
  socket.on = (event: string, fn: Listener) => {
    if (RESERVED.has(event) || typeof fn !== 'function') return origOn(event, fn)
    const w = function (this: unknown, ...args: unknown[]) {
      const t0 = performance.now()
      let r: unknown
      try {
        r = fn.apply(this, args)
      } catch (err) {
        finish(event, t0, performance.now() - t0)
        throw err
      }
      const syncMs = performance.now() - t0
      if (r && typeof (r as Promise<unknown>).then === 'function') {
        ;(r as Promise<unknown>).then(
          () => finish(event, t0, syncMs),
          () => finish(event, t0, syncMs)
        )
      } else finish(event, t0, syncMs)
      return r
    }
    wrapped.set(fn, w)
    return origOn(event, w)
  }
  for (const name of ['off', 'removeListener'] as const) {
    const orig = socket[name]?.bind(socket)
    if (!orig) continue
    socket[name] = (event: string, fn: Listener) => orig(event, wrapped.get(fn) ?? fn)
  }
}

// ── Room gaps (#2462) ───────────────────────────────────────────────────────

/** A connected client reported a gap in one room and asked for that room's catch-up. */
export function noteRoomGap(
  tenant: string | null,
  room: string,
  missed: number,
  outcome: 'replayed' | 'full'
): void {
  const g = scopeOf(tenant).gaps
  const n = Math.max(0, Math.min(10_000, Math.floor(missed) || 0))
  g.reports++
  g.missed += n
  if (outcome === 'full') g.full++
  else g.replayed++
  let kind = roomKind(room)
  if (!g.by_kind.has(kind) && g.by_kind.size >= 100) kind = 'other'
  const row = g.by_kind.get(kind) ?? { reports: 0, missed: 0 }
  row.reports++
  row.missed += n
  g.by_kind.set(kind, row)
}

// ── Slow consumers (#2460) + write buffers (#2488) ──────────────────────────

/** The slice of an engine.io socket the tracker reads. */
export interface EngineConnLike {
  writeBuffer?: Array<{ data?: unknown }>
  transport?: { name?: string; socket?: { bufferedAmount?: number } }
  on?(event: string, fn: (...args: any[]) => void): unknown
}

export interface SocketInfo {
  user: string | null
  app: string | null
  transport: string | null
  /** Rooms this socket is in, tenant prefix as stored (credential rooms included; filtered). */
  rooms: Iterable<string>
}

export interface TrackOptions {
  id: string
  conn: EngineConnLike
  tenant: () => string | null
  info: () => SocketInfo
  /** Write one packet straight to the engine (never held). */
  sendRaw: (encoded: string) => void
  /** Close the connection now, dropping what is queued. */
  drop: () => void
  /** The hard limit closed the socket (resync marker, logging). */
  onHardLimit?: (waiting: number) => void
  limits?: { soft: number; hard: number }
  /** Tick for the soft-mode recovery check (tests use a short one). */
  tickMs?: number
}

export interface SocketBuffer {
  /** Bytes waiting to be sent to this client right now. */
  waiting(): number
  /** True = hold this packet (the socket is over the soft limit and it is a room broadcast). */
  intercept(encoded: unknown, room: string | null, volatile: boolean): boolean
  /** After a write: enter soft mode or close at the hard limit. */
  check(): void
  dispose(): void
  state(): BufferView
}

export interface BufferView {
  waiting: number
  peak: number
  mode: 'ok' | 'soft'
  soft_since: string | null
  soft_count: number
  held_rooms: number
  suppressed: number
  limits: { soft: number; hard: number }
}

/** Events a socket over the soft limit still gets (control and sign-in signals). */
const PASS_EVENTS = new Set([
  'realtime:stale',
  'session:ended',
  'access:changed',
  'client:force-refresh',
  'config:update',
  'catchup:full',
  'catchup:events',
  'catchup:cursor',
  'catchup:room:events',
  'auth:ok',
  'nvr:ping'
])

/** Rooms whose broadcasts are personal or control signals — never held. */
function passRoom(room: string): boolean {
  const r = splitTenantRoom(room).room
  return (
    r === 'all' ||
    r.startsWith('user:') ||
    r.startsWith('tenant:') ||
    r.startsWith('session:') ||
    r.startsWith('masq:')
  )
}

function bytesOf(data: unknown): number {
  if (typeof data === 'string') return Buffer.byteLength(data)
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) return data.byteLength
  return 0
}

interface Tracked {
  opts: TrackOptions
  buf: SocketBuffer
  queued: () => number
  peak: () => number
  mode: () => 'ok' | 'soft'
}
const tracked = new Map<string, Tracked>()

export function trackSocket(opts: TrackOptions): SocketBuffer {
  const limits = opts.limits ?? bufferLimits()
  let queued = 0
  let peak = 0
  let mode: 'ok' | 'soft' = 'ok'
  let softSince: number | null = null
  let softCount = 0
  let suppressed = 0
  let closed = false
  const held = new Set<string>()
  let overflow = false
  let timer: ReturnType<typeof setInterval> | null = null

  opts.conn.on?.('packetCreate', (p: { data?: unknown }) => {
    queued += bytesOf(p?.data)
  })
  opts.conn.on?.('flush', (wbuf: Array<{ data?: unknown }>) => {
    let n = 0
    for (const p of wbuf ?? []) n += bytesOf(p?.data)
    queued = Math.max(0, queued - n)
  })

  const waiting = () => {
    const t = opts.conn.transport
    const ws = t?.name === 'websocket' ? Number(t.socket?.bufferedAmount ?? 0) : 0
    const w = queued + (Number.isFinite(ws) ? ws : 0)
    if (w > peak) peak = w
    return w
  }

  const leaveSoft = () => {
    mode = 'ok'
    softSince = null
    if (timer) clearInterval(timer)
    timer = null
    if ((held.size === 0 && !overflow) || closed) return
    const rooms = [...held]
    // Too many rooms to name: the client reloads everything it shows instead.
    const all = overflow
    held.clear()
    overflow = false
    scopeOf(opts.tenant()).staleSent++
    try {
      opts.sendRaw(
        encodeEvent('realtime:stale', {
          rooms,
          ...(all ? { all: true } : {}),
          reason: 'slow-consumer'
        })
      )
    } catch {
      /* the socket went away */
    }
  }

  const hardClose = (w: number) => {
    if (closed) return
    closed = true
    if (timer) clearInterval(timer)
    timer = null
    const s = scopeOf(opts.tenant())
    s.hardDisconnects++
    const info = safeInfo(opts)
    s.disconnects.unshift({
      at: new Date().toISOString(),
      user: info?.user ?? null,
      app: info?.app ?? null,
      waiting: w
    })
    if (s.disconnects.length > 20) s.disconnects.length = 20
    try {
      opts.onHardLimit?.(w)
    } catch {
      /* best-effort */
    }
    opts.drop()
  }

  const check = () => {
    if (closed) return
    const w = waiting()
    if (w > limits.hard) {
      hardClose(w)
      return
    }
    if (mode === 'ok' && w > limits.soft) {
      mode = 'soft'
      softSince = Date.now()
      softCount++
      scopeOf(opts.tenant()).softEntered++
      timer = setInterval(() => {
        const now = waiting()
        if (now > limits.hard) hardClose(now)
        else if (now < limits.soft / 2) leaveSoft()
      }, opts.tickMs ?? 1000)
      ;(timer as { unref?: () => void }).unref?.()
    }
  }

  const buf: SocketBuffer = {
    waiting,
    intercept(encoded, room, volatile) {
      if (mode !== 'soft' || closed) return false
      if (typeof encoded !== 'string' || encoded.charCodeAt(0) !== 50 /* '2' event */) return false
      const event = eventNameOf(encoded)
      if (event && PASS_EVENTS.has(event)) return false
      if (room == null || passRoom(room)) return false
      suppressed++
      scopeOf(opts.tenant()).suppressed++
      // A volatile packet may be dropped by definition — no refetch owed for it.
      if (!volatile && !isCredentialRoom(room)) {
        const r = splitTenantRoom(room).room
        if (held.size < 500 || held.has(r)) held.add(r)
        else overflow = true
      }
      return true
    },
    check,
    dispose() {
      closed = true
      if (timer) clearInterval(timer)
      timer = null
      tracked.delete(opts.id)
    },
    state() {
      return {
        waiting: waiting(),
        peak,
        mode,
        soft_since: softSince ? new Date(softSince).toISOString() : null,
        soft_count: softCount,
        held_rooms: held.size,
        suppressed,
        limits
      }
    }
  }
  tracked.set(opts.id, {
    opts,
    buf,
    queued: () => queued,
    peak: () => peak,
    mode: () => mode
  })
  return buf
}

function safeInfo(opts: TrackOptions): SocketInfo | null {
  try {
    return opts.info()
  } catch {
    return null
  }
}

/** One tracked socket's buffer state (Socket inspector); null when not tracked here. */
export function socketBufferState(socketId: string, tenant: string | null): BufferView | null {
  const t = tracked.get(socketId)
  if (!t || (t.opts.tenant() ?? '') !== (tenant ?? '')) return null
  return t.buf.state()
}

// ── Snapshots ───────────────────────────────────────────────────────────────

export interface TopSocket {
  instance: string
  id: string
  user: string | null
  app: string | null
  transport: string | null
  waiting: number
  peak: number
  mode: 'ok' | 'soft'
  rooms: number
}

export interface HealthSnapshot {
  instance: string
  at: number
  limits: { soft: number; hard: number }
  sockets: number
  waiting_bytes: number
  soft_now: number
  counters: {
    soft_entered: number
    hard_disconnects: number
    stale_sent: number
    suppressed: number
  }
  top: TopSocket[]
  rooms: Array<{ room: string; size: number }>
  growth: GrowthPoint[]
  disconnects: Disconnect[]
  handlers: Record<string, HandlerStat>
  slowest: SlowCall[]
  gaps: {
    reports: number
    missed: number
    replayed: number
    full: number
    by_kind: Record<string, { reports: number; missed: number }>
  }
}

/** This process's figures for every scope it has seen (tracked sockets read live). */
export function localSnapshots(now = Date.now()): Map<string, HealthSnapshot> {
  const limits = bufferLimits()
  const live = new Map<
    string,
    { sockets: number; waiting: number; soft: number; top: TopSocket[]; rooms: Map<string, number> }
  >()
  for (const [id, t] of tracked) {
    const key = t.opts.tenant() ?? ''
    let row = live.get(key)
    if (!row) {
      row = { sockets: 0, waiting: 0, soft: 0, top: [], rooms: new Map() }
      live.set(key, row)
    }
    const w = t.buf.waiting()
    const info = safeInfo(t.opts)
    row.sockets++
    row.waiting += w
    if (t.mode() === 'soft') row.soft++
    let roomCount = 0
    for (const r of info?.rooms ?? []) {
      if (r === id || isCredentialRoom(r)) continue
      roomCount++
      const name = key ? splitTenantRoom(r).room : r
      row.rooms.set(name, (row.rooms.get(name) ?? 0) + 1)
    }
    row.top.push({
      instance: INSTANCE_ID,
      id,
      user: info?.user ?? null,
      app: info?.app ?? null,
      transport: info?.transport ?? null,
      waiting: w,
      peak: t.peak(),
      mode: t.mode(),
      rooms: roomCount
    })
  }
  const out = new Map<string, HealthSnapshot>()
  const keys = new Set([...scopes.keys(), ...live.keys()])
  const minute = Math.floor(now / 60_000)
  for (const key of keys) {
    const s = scopeOf(key)
    const l = live.get(key) ?? { sockets: 0, waiting: 0, soft: 0, top: [], rooms: new Map() }
    const handlers: Record<string, HandlerStat> = {}
    for (const [m, map] of s.minutes) {
      if (m <= minute - WINDOW_MIN) continue
      for (const [h, st] of map) {
        handlers[h] ??= emptyStat()
        mergeStat(handlers[h], st)
      }
    }
    out.set(key, {
      instance: INSTANCE_ID,
      at: now,
      limits,
      sockets: l.sockets,
      waiting_bytes: l.waiting,
      soft_now: l.soft,
      counters: {
        soft_entered: s.softEntered,
        hard_disconnects: s.hardDisconnects,
        stale_sent: s.staleSent,
        suppressed: s.suppressed
      },
      top: l.top.sort((a, b) => b.waiting - a.waiting || b.peak - a.peak).slice(0, 15),
      rooms: [...l.rooms.entries()]
        .map(([room, size]) => ({ room, size }))
        .sort((a, b) => b.size - a.size)
        .slice(0, 30),
      growth: [...s.growth],
      disconnects: [...s.disconnects],
      handlers,
      slowest: [...s.slowest],
      gaps: {
        reports: s.gaps.reports,
        missed: s.gaps.missed,
        replayed: s.gaps.replayed,
        full: s.gaps.full,
        by_kind: Object.fromEntries(s.gaps.by_kind)
      }
    })
  }
  return out
}

/** Append one growth point per scope (every SAMPLE_MS): total and largest waiting bytes. */
export function sampleGrowth(now = Date.now()): void {
  const t = Math.floor(now / SAMPLE_MS) * SAMPLE_MS
  const sums = new Map<string, { total: number; max: number }>()
  for (const tr of tracked.values()) {
    const key = tr.opts.tenant() ?? ''
    const w = tr.buf.waiting()
    const row = sums.get(key) ?? { total: 0, max: 0 }
    row.total += w
    row.max = Math.max(row.max, w)
    sums.set(key, row)
  }
  for (const key of scopes.keys()) if (!sums.has(key)) sums.set(key, { total: 0, max: 0 })
  for (const [key, v] of sums) {
    const g = scopeOf(key).growth
    if (g.length && g[g.length - 1].t === t) g[g.length - 1] = { t, ...v }
    else g.push({ t, ...v })
    if (g.length > GROWTH_POINTS) g.splice(0, g.length - GROWTH_POINTS)
  }
}

export interface MergedHealth {
  replicas: number
  instances: string[]
  limits: { soft: number; hard: number }
  sockets: number
  waiting_bytes: number
  soft_now: number
  counters: HealthSnapshot['counters']
  top: TopSocket[]
  rooms: Array<{ room: string; size: number }>
  growth: GrowthPoint[]
  disconnects: Disconnect[]
  handlers: Array<{
    handler: string
    count: number
    avg_ms: number
    p50_ms: number
    p95_ms: number
    max_ms: number
    sync_max_ms: number
  }>
  slowest: Array<SlowCall & { instance?: string }>
  gaps: {
    reports: number
    missed: number
    replayed: number
    full: number
    by_kind: Array<{ kind: string; reports: number; missed: number }>
  }
}

/** Every replica's snapshot of one scope → one view (sums, merged histograms, aligned growth). */
export function mergeHealth(snaps: HealthSnapshot[]): MergedHealth {
  const counters = { soft_entered: 0, hard_disconnects: 0, stale_sent: 0, suppressed: 0 }
  const handlers = new Map<string, HandlerStat>()
  const growth = new Map<number, GrowthPoint>()
  const rooms = new Map<string, number>()
  const byKind = new Map<string, { reports: number; missed: number }>()
  const gaps = { reports: 0, missed: 0, replayed: 0, full: 0 }
  let sockets = 0
  let waiting = 0
  let softNow = 0
  const top: TopSocket[] = []
  const disconnects: Disconnect[] = []
  const slowest: Array<SlowCall & { instance?: string }> = []
  for (const s of snaps) {
    sockets += s.sockets
    waiting += s.waiting_bytes
    softNow += s.soft_now
    for (const k of Object.keys(counters) as Array<keyof typeof counters>)
      counters[k] += s.counters?.[k] ?? 0
    top.push(...(s.top ?? []))
    disconnects.push(...(s.disconnects ?? []))
    for (const c of s.slowest ?? []) slowest.push({ ...c, instance: s.instance })
    for (const [h, st] of Object.entries(s.handlers ?? {})) {
      const into = handlers.get(h) ?? emptyStat()
      mergeStat(into, st)
      handlers.set(h, into)
    }
    for (const p of s.growth ?? []) {
      const cur = growth.get(p.t) ?? { t: p.t, total: 0, max: 0 }
      cur.total += p.total
      cur.max = Math.max(cur.max, p.max)
      growth.set(p.t, cur)
    }
    for (const r of s.rooms ?? []) rooms.set(r.room, (rooms.get(r.room) ?? 0) + r.size)
    gaps.reports += s.gaps?.reports ?? 0
    gaps.missed += s.gaps?.missed ?? 0
    gaps.replayed += s.gaps?.replayed ?? 0
    gaps.full += s.gaps?.full ?? 0
    for (const [k, v] of Object.entries(s.gaps?.by_kind ?? {})) {
      const row = byKind.get(k) ?? { reports: 0, missed: 0 }
      row.reports += v.reports
      row.missed += v.missed
      byKind.set(k, row)
    }
  }
  return {
    replicas: snaps.length,
    instances: snaps.map((s) => s.instance),
    limits: snaps[0]?.limits ?? bufferLimits(),
    sockets,
    waiting_bytes: waiting,
    soft_now: softNow,
    counters,
    top: top.sort((a, b) => b.waiting - a.waiting || b.peak - a.peak).slice(0, 20),
    rooms: [...rooms.entries()]
      .map(([room, size]) => ({ room, size }))
      .sort((a, b) => b.size - a.size)
      .slice(0, 30),
    growth: [...growth.values()].sort((a, b) => a.t - b.t),
    disconnects: disconnects.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20),
    handlers: [...handlers.entries()]
      .map(([handler, st]) => ({
        handler,
        count: st.count,
        avg_ms: st.count ? round(st.total / st.count) : 0,
        p50_ms: histQuantile(st.hist, 0.5, st.max),
        p95_ms: histQuantile(st.hist, 0.95, st.max),
        max_ms: round(st.max),
        sync_max_ms: round(st.sync_max)
      }))
      .sort((a, b) => b.p95_ms - a.p95_ms || b.count - a.count),
    slowest: slowest.sort((a, b) => b.ms - a.ms).slice(0, SLOWEST),
    gaps: {
      ...gaps,
      by_kind: [...byKind.entries()]
        .map(([kind, v]) => ({ kind, ...v }))
        .sort((a, b) => b.missed - a.missed || b.reports - a.reports)
    }
  }
}

// ── Redis (cross-replica) ───────────────────────────────────────────────────

const KEY_PREFIX = 'nvr:rt:health:'
const KEY_TTL_S = 30
let redisRef: Redis | null = null
let sampler: ReturnType<typeof setInterval> | null = null

async function publish(): Promise<void> {
  if (!redisRef) return
  const scoped: Record<string, HealthSnapshot> = {}
  for (const [k, v] of localSnapshots()) scoped[k] = v
  try {
    await redisRef.set(`${KEY_PREFIX}${INSTANCE_ID}`, JSON.stringify(scoped), 'EX', KEY_TTL_S)
  } catch {
    /* transient — the next sample publishes again */
  }
}

/** Start sampling growth + publishing this process's figures (once, from the socket plugin). */
export function startSocketHealth(redis: Redis | null): void {
  redisRef = redis
  if (sampler) return
  sampler = setInterval(() => {
    sampleGrowth()
    void publish()
  }, SAMPLE_MS)
  sampler.unref?.()
}

export function stopSocketHealth(): void {
  if (sampler) clearInterval(sampler)
  sampler = null
}

/**
 * The deployment's view for one scope: this process live, every other replica from Redis.
 * Without Redis (or when it fails) it is this process only, and says so (`replicas: 1`).
 */
export async function readSocketHealth(tenant: string | null): Promise<MergedHealth> {
  const key = tenant ?? ''
  const snaps: HealthSnapshot[] = []
  const mine = localSnapshots().get(key)
  if (mine) snaps.push(mine)
  if (redisRef) {
    try {
      const keys: string[] = []
      let cursor = '0'
      do {
        const [next, batch] = await redisRef.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 100)
        cursor = next
        keys.push(...batch)
      } while (cursor !== '0' && keys.length < 200)
      const others = keys.filter((k) => k !== `${KEY_PREFIX}${INSTANCE_ID}`)
      if (others.length) {
        const vals = await redisRef.mget(others)
        for (const v of vals) {
          if (!v) continue
          try {
            const snap = (JSON.parse(v) as Record<string, HealthSnapshot>)[key]
            if (snap) snaps.push(snap)
          } catch {
            /* a corrupt entry is skipped */
          }
        }
      }
    } catch {
      /* Redis unavailable — this process only */
    }
  }
  return mergeHealth(snaps)
}

// ── Resync after a hard-limit close ─────────────────────────────────────────

const RESYNC_TTL_S = 300
const resyncKey = (user: string, tab: string) => `nvr:rt:resync:${user}:${tab}`

/** The tab closed at the hard limit reloads its data on reconnect instead of replaying. */
export async function markResync(user: string | null, tab: string | null): Promise<void> {
  if (!redisRef || !user || !tab) return
  try {
    await redisRef.set(resyncKey(user, tab), 'slow-consumer', 'EX', RESYNC_TTL_S)
  } catch {
    /* best-effort: the reconnect's own catch-up still runs */
  }
}

/** Whether this tab owes a full resync (one-shot). */
export async function takeResync(user: string | null, tab: string | null): Promise<boolean> {
  if (!redisRef || !user || !tab) return false
  try {
    const res = await redisRef.multi().get(resyncKey(user, tab)).del(resyncKey(user, tab)).exec()
    return !!res?.[0]?.[1]
  } catch {
    return false
  }
}
