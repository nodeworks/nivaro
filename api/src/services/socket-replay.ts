/**
 * Socket traffic replay (#2478) — the socket side of traffic:replay (#1159).
 *
 * 1. CAPTURE, on production (admin, GET /api/realtime/replay/capture): a window (≤ 15 minutes,
 *    what the stream keeps) of the Redis event stream `nvr:ev:stream`, reduced to ids — event
 *    name, room, collection, record ids, action, payload size; never values — plus the room-join
 *    mix (rooms and their sizes on that server) and connection counts (the newest concurrency
 *    sample of every instance). Sign-in rooms are dropped.
 * 2. REPLAY, against staging (`pnpm --filter @nivaro/api run realtime:replay`, the script in
 *    scripts/realtime-replay.ts): simulated socket clients built the way the realtime load test
 *    (#1754) builds them sign in to the target, join MIRROR rooms (`rtreplay:<run>:<room>`) in
 *    the captured mix, and the target emits the captured events into those mirror rooms through
 *    the normal emit path (sequence, journal, stream) at 1×, 2× or 5×. Real people on staging
 *    never receive a replayed event: nobody else is in a mirror room.
 * 3. REPORT: delivery latency from the clients (p50/p95/p99, loss) plus the target's own API CPU,
 *    event-loop delay and Redis load (INFO deltas) over the run.
 *
 * Staging only. The script refuses the capture's own origin, this instance's PUBLIC_URL /
 * ADMIN_URL, the database host, every host in a Production environment of the Environments
 * registry and anything in TRAFFIC_REPLAY_SHARED_HOSTS. The target itself refuses unless it
 * runs with REALTIME_REPLAY=on, is not in cloud mode, and is not the capture's origin.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { Redis } from 'ioredis'
import { hostOf } from './traffic-replay.js'

export const CAPTURE_MAX_MINUTES = 15
export const CAPTURE_MAX_EVENTS = 5000
export const REPLAY_SPEEDS = [1, 2, 5] as const
export const REPLAY_MAX_RUN_MS = 30 * 60_000
const PAD_MAX = 8192
const STREAM_KEY = 'nvr:ev:stream'

export interface CapturedEvent {
  /** Milliseconds after the window's first event. */
  t: number
  room: string
  event: string
  ids: { collection?: string; item?: string; items?: string[]; action?: string }
  /** Size of the original payload (the replay pads to it, so bandwidth matches). */
  bytes: number
}

export interface SocketCapture {
  version: 1
  origin: string | null
  captured_at: string
  window_ms: number
  events: CapturedEvent[]
  rooms: Array<{ room: string; size: number }>
  connections: {
    sockets: number
    users: number
    /** Sockets on the server that answered the capture (the room sizes are from it). */
    local_sockets: number
    instances: Array<{ instance: string; sockets: number; users: number }>
  }
}

/** Ids only from an event payload (pure). */
export function idsOnly(payload: unknown): CapturedEvent['ids'] {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const out: CapturedEvent['ids'] = {}
  if (typeof p.collection === 'string' && /^[\w-]{1,128}$/.test(p.collection))
    out.collection = p.collection
  if (typeof p.item === 'string' || typeof p.item === 'number')
    out.item = String(p.item).slice(0, 64)
  if (Array.isArray(p.items))
    out.items = p.items
      .filter((v) => typeof v === 'string' || typeof v === 'number')
      .slice(0, 200)
      .map((v) => String(v).slice(0, 64))
  if (typeof p.action === 'string' && /^(create|update|delete)$/.test(p.action))
    out.action = p.action
  return out
}

/** Rooms a capture never carries: sign-in rooms (pure). */
function captureRoom(room: string): boolean {
  const r = room.replace(/^t:[^:]+:/, '')
  return !r.startsWith('session:') && !r.startsWith('masq:') && !r.startsWith('probe:')
}

/** A capture from decoded stream entries and the room / connection snapshot (pure). */
export function buildCapture(input: {
  entries: Array<{ at: number; room: string; event: string; payload: unknown }>
  rooms: Array<{ room: string; size: number }>
  localSockets: number
  instances: Array<{ instance: string; sockets: number; users: number }>
  origin: string | null
  now?: number
}): SocketCapture {
  const sorted = input.entries
    .filter((e) => Number.isFinite(e.at) && e.at > 0 && captureRoom(e.room))
    .sort((a, b) => a.at - b.at)
    .slice(-CAPTURE_MAX_EVENTS)
  const t0 = sorted[0]?.at ?? 0
  const events = sorted.map((e) => ({
    t: e.at - t0,
    room: e.room.slice(0, 200),
    event: e.event.slice(0, 80),
    ids: idsOnly(e.payload),
    bytes: Math.min(PAD_MAX, Buffer.byteLength(JSON.stringify(e.payload ?? {})))
  }))
  const sockets = input.instances.reduce((s, i) => s + i.sockets, 0)
  return {
    version: 1,
    origin: hostOf(input.origin),
    captured_at: new Date(input.now ?? Date.now()).toISOString(),
    window_ms: events.length ? events[events.length - 1].t : 0,
    events,
    rooms: input.rooms.filter((r) => captureRoom(r.room)).slice(0, 500),
    connections: {
      sockets: sockets || input.localSockets,
      users: input.instances.reduce((s, i) => s + i.users, 0),
      local_sockets: input.localSockets,
      instances: input.instances
    }
  }
}

/** Read the stream window and the snapshot on this server (production side). */
export async function captureSocketTraffic(
  redis: Redis,
  minutes: number,
  snapshot: {
    rooms: Array<{ room: string; size: number }>
    localSockets: number
    instances: Array<{ instance: string; sockets: number; users: number }>
    origin: string | null
  }
): Promise<SocketCapture> {
  const { decodeStreamEntry } = await import('./event-stream.js')
  const span = Math.max(1, Math.min(CAPTURE_MAX_MINUTES, minutes)) * 60_000
  const from = Date.now() - span
  const raw = (await redis.xrange(
    STREAM_KEY,
    String(from),
    '+',
    'COUNT',
    CAPTURE_MAX_EVENTS
  )) as Array<[string, string[]]>
  const entries: Array<{ at: number; room: string; event: string; payload: unknown }> = []
  for (const [id, fields] of raw ?? []) {
    const d = decodeStreamEntry(fields)
    if (!d) continue
    // The probe's self-delivered entries are not traffic.
    if (d.self) continue
    entries.push({
      at: d.at || Number(id.split('-')[0]) || 0,
      room: d.entry.room,
      event: d.entry.event,
      payload: d.entry.payload
    })
  }
  return buildCapture({ entries, ...snapshot })
}

// ─── Guards ────────────────────────────────────────────────────────────────────

/** Why the script may not replay against `target`, or null (pure). */
export function socketReplayRefusal(
  target: string,
  ctx: { origin: string | null; refused: Array<string | null | undefined> }
): string | null {
  let u: URL
  try {
    u = new URL(target)
  } catch {
    return 'target must be an http(s) URL, e.g. https://staging.example.com'
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'target must be http or https'
  const t = hostOf(target)
  const bare = u.hostname.toLowerCase()
  const same = (raw: string | null | undefined) => {
    const h = hostOf(raw ?? null)
    if (!h) return false
    // An entry without a port covers every port of that host; with one, that port only.
    return h === t || (!h.includes(':') && h === bare)
  }
  if (ctx.origin && same(ctx.origin))
    return `${t} is where the capture came from — replay only against staging`
  for (const raw of ctx.refused) {
    if (raw && same(raw)) return `${t} is a refused host (${raw}) — replay only against staging`
  }
  return null
}

/** Why the target refuses a replay run, or null (pure). */
export function replayServerRefusal(
  env: NodeJS.ProcessEnv,
  ctx: { captureOrigin: string | null; selfHosts: Array<string | null | undefined> }
): string | null {
  if (env.CLOUD_META_DB_URL) return 'Socket replay never runs in cloud mode'
  if (String(env.REALTIME_REPLAY ?? '').toLowerCase() !== 'on')
    return 'This server does not accept socket replays (set REALTIME_REPLAY=on on staging)'
  const origin = hostOf(ctx.captureOrigin)
  if (origin) {
    for (const h of ctx.selfHosts) {
      const mine = hostOf(h ?? null)
      if (
        mine &&
        (mine === origin ||
          (!origin.includes(':') && mine.split(':')[0] === origin) ||
          (!mine.includes(':') && origin.split(':')[0] === mine))
      )
        return 'The capture came from this server — replay it on staging, not where it was taken'
    }
  }
  return null
}

// ─── Plans (pure) ──────────────────────────────────────────────────────────────

/**
 * Which mirror rooms each simulated client joins: every captured room keeps its share of the
 * captured sockets, scaled to `clients` (at least one member for a room that had any, capped at
 * `clients`), spread round-robin so one client is not in everything. Rooms that only appear in
 * the event list (nobody was in them at capture time) get no members, as on production.
 */
export function planReplayClients(
  capture: Pick<SocketCapture, 'rooms' | 'connections'>,
  clients: number,
  maxRoomsPerClient = 50
): string[][] {
  const n = Math.max(0, Math.floor(clients))
  const out: string[][] = Array.from({ length: n }, () => [])
  if (n === 0) return out
  const scale = n / Math.max(1, capture.connections.local_sockets)
  let cursor = 0
  for (const r of capture.rooms) {
    if (r.size <= 0) continue
    const members = Math.min(n, Math.max(1, Math.round(r.size * scale)))
    let placed = 0
    let tries = 0
    while (placed < members && tries < n) {
      const c = out[cursor % n]
      cursor++
      tries++
      if (c.length >= maxRoomsPerClient || c.includes(r.room)) continue
      c.push(r.room)
      placed++
    }
  }
  return out
}

export interface ReplayEmit {
  at: number
  room: string
  event: string
  ids: CapturedEvent['ids']
  bytes: number
}

/** The emit schedule at a speed: offsets divided by it (pure). */
export function planReplayEmits(
  capture: Pick<SocketCapture, 'events'>,
  speed: number
): ReplayEmit[] {
  const s = (REPLAY_SPEEDS as readonly number[]).includes(speed) ? speed : 1
  return capture.events.map((e) => ({
    at: Math.round(e.t / s),
    room: e.room,
    event: e.event,
    ids: e.ids,
    bytes: e.bytes
  }))
}

/** The mirror room a captured room replays into (tenant prefix dropped). */
export function mirrorRoom(runId: string, room: string): string {
  return `rtreplay:${runId}:${room.replace(/^t:[^:]+:/, '')}`
}

/**
 * Payload for one replayed event: the ids, the run marker, the server time it left (`_rs`, the
 * clients measure delivery from it) and padding to the original size.
 */
export function replayPayload(
  e: ReplayEmit,
  runId: string,
  now: number = Date.now()
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...e.ids, _replay: runId, _rs: now }
  const size = Buffer.byteLength(JSON.stringify(body))
  if (e.bytes > size + 10) body._pad = 'x'.repeat(Math.min(PAD_MAX, e.bytes - size - 10))
  return body
}

// ─── Target-side run ───────────────────────────────────────────────────────────

interface Run {
  id: string
  secretHash: string
  speed: number
  emits: ReplayEmit[]
  created_at: number
  started_at: number | null
  stopped_at: number | null
  emitted: number
  failed: number
  emitMs: number[]
  timers: Array<ReturnType<typeof setTimeout>>
  cpu0: NodeJS.CpuUsage | null
  wall0: number
  loop: ReturnType<typeof monitorEventLoopDelay> | null
  redis0: Record<string, number> | null
  started_by: string | null
}

const runs = new Map<string, Run>()

export class ReplayError extends Error {
  statusCode: number
  constructor(message: string, statusCode = 400) {
    super(message)
    this.statusCode = statusCode
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

/** Redis INFO figures the report compares (pure parse). */
export function parseRedisInfo(raw: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const k of [
    'total_commands_processed',
    'total_net_input_bytes',
    'total_net_output_bytes',
    'used_cpu_sys',
    'used_cpu_user',
    'instantaneous_ops_per_sec',
    'connected_clients'
  ]) {
    const m = new RegExp(`^${k}:([\\d.]+)`, 'm').exec(raw)
    if (m) out[k] = Number(m[1])
  }
  return out
}

async function redisInfo(redis: Redis | null): Promise<Record<string, number> | null> {
  if (!redis) return null
  try {
    return parseRedisInfo(
      `${await redis.info('stats')}\n${await redis.info('cpu')}\n${await redis.info('clients')}`
    )
  } catch {
    return null
  }
}

export function createReplayRun(
  body: unknown,
  by: string | null
): { id: string; secret: string; emits: number; duration_ms: number } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const capture = b.capture as SocketCapture | undefined
  if (capture?.version !== 1 || !Array.isArray(capture.events))
    throw new ReplayError('capture must be a socket capture (version 1)')
  if (capture.events.length > CAPTURE_MAX_EVENTS)
    throw new ReplayError(`a capture holds at most ${CAPTURE_MAX_EVENTS} events`)
  const speed = Number(b.speed ?? 1)
  if (!(REPLAY_SPEEDS as readonly number[]).includes(speed))
    throw new ReplayError('speed must be 1, 2 or 5')
  if ([...runs.values()].some((r) => r.stopped_at == null))
    throw new ReplayError('A socket replay is already running on this server', 409)
  const emits = planReplayEmits(capture, speed)
  const duration = emits.length ? emits[emits.length - 1].at : 0
  if (duration > REPLAY_MAX_RUN_MS) throw new ReplayError('the replay would run past 30 minutes')
  const id = randomUUID().slice(0, 12)
  const secret = randomBytes(18).toString('hex')
  runs.set(id, {
    id,
    secretHash: sha(secret),
    speed,
    emits,
    created_at: Date.now(),
    started_at: null,
    stopped_at: null,
    emitted: 0,
    failed: 0,
    emitMs: [],
    timers: [],
    cpu0: null,
    wall0: 0,
    loop: null,
    redis0: null,
    started_by: by
  })
  // A run nobody starts or stops expires.
  const expire = setTimeout(
    () => {
      const r = runs.get(id)
      if (r && r.stopped_at == null) void stopReplayRun(id, null)
    },
    REPLAY_MAX_RUN_MS + 10 * 60_000
  )
  expire.unref?.()
  return { id, secret, emits: emits.length, duration_ms: duration }
}

/** May a socket join this run's mirror room? (secret + an open run). */
export function replayJoinAllowed(runId: string, secret: unknown): boolean {
  const r = runs.get(String(runId))
  if (!r || r.stopped_at != null || typeof secret !== 'string') return false
  return sha(secret) === r.secretHash
}

export async function goReplayRun(
  id: string,
  secret: unknown,
  redis: Redis | null
): Promise<{ started_at: number; emits: number }> {
  const r = runs.get(id)
  if (!r || !replayJoinAllowed(id, secret)) throw new ReplayError('No such replay run', 404)
  if (r.started_at != null) throw new ReplayError('This replay already started', 409)
  const { journaledEmit } = await import('./event-journal.js')
  r.started_at = Date.now()
  r.cpu0 = process.cpuUsage()
  r.wall0 = performance.now()
  r.loop = monitorEventLoopDelay({ resolution: 20 })
  r.loop.enable()
  r.redis0 = await redisInfo(redis)
  for (const e of r.emits) {
    const t = setTimeout(() => {
      const t0 = performance.now()
      journaledEmit(mirrorRoom(r.id, e.room), e.event, replayPayload(e, r.id)).then(
        () => {
          r.emitted++
          if (r.emitMs.length < 20_000) r.emitMs.push(performance.now() - t0)
        },
        () => {
          r.failed++
        }
      )
    }, e.at)
    t.unref?.()
    r.timers.push(t)
  }
  return { started_at: r.started_at, emits: r.emits.length }
}

const pct = (sorted: number[], p: number) =>
  sorted.length
    ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] * 10) / 10
    : null

export interface ReplayServerReport {
  id: string
  speed: number
  planned: number
  emitted: number
  failed: number
  wall_s: number
  emit_ms: { p50: number | null; p95: number | null; max: number | null }
  api_cpu_pct: number | null
  event_loop_ms: { p50: number | null; p99: number | null; max: number | null }
  redis: Record<string, number> | null
}

export async function stopReplayRun(
  id: string,
  secret: unknown,
  redis: Redis | null = null
): Promise<ReplayServerReport> {
  const r = runs.get(id)
  // `secret` null = the run's own expiry timer.
  if (!r || (secret !== null && (typeof secret !== 'string' || sha(secret) !== r.secretHash)))
    throw new ReplayError('No such replay run', 404)
  for (const t of r.timers) clearTimeout(t)
  r.timers = []
  r.stopped_at ??= Date.now()
  const wallMs = r.started_at != null ? performance.now() - r.wall0 : 0
  const cpu = r.cpu0 ? process.cpuUsage(r.cpu0) : null
  const loop = r.loop
  loop?.disable()
  const redis1 = await redisInfo(redis)
  const delta: Record<string, number> | null =
    r.redis0 && redis1
      ? Object.fromEntries(
          Object.keys(redis1).map((k) => [
            k,
            /instantaneous|connected/.test(k)
              ? redis1[k]
              : Math.round(((redis1[k] ?? 0) - (r.redis0?.[k] ?? 0)) * 1000) / 1000
          ])
        )
      : null
  const sorted = [...r.emitMs].sort((a, b) => a - b)
  const ns = (v: number | undefined) =>
    v == null || !Number.isFinite(v) ? null : Math.round((v / 1e6) * 10) / 10
  // A run is kept a while for the report, then forgotten.
  const forget = setTimeout(() => runs.delete(id), 30 * 60_000)
  forget.unref?.()
  return {
    id,
    speed: r.speed,
    planned: r.emits.length,
    emitted: r.emitted,
    failed: r.failed,
    wall_s: Math.round(wallMs / 100) / 10,
    emit_ms: { p50: pct(sorted, 0.5), p95: pct(sorted, 0.95), max: pct(sorted, 1) },
    api_cpu_pct:
      cpu && wallMs > 0 ? Math.round(((cpu.user + cpu.system) / 1000 / wallMs) * 1000) / 10 : null,
    event_loop_ms: loop
      ? { p50: ns(loop.percentile(50)), p99: ns(loop.percentile(99)), max: ns(loop.max) }
      : { p50: null, p99: null, max: null },
    redis: delta
  }
}

export function replayRunsView(): Array<{
  id: string
  speed: number
  planned: number
  emitted: number
  state: 'ready' | 'running' | 'stopped'
  created_at: string
}> {
  return [...runs.values()].map((r) => ({
    id: r.id,
    speed: r.speed,
    planned: r.emits.length,
    emitted: r.emitted,
    state: r.stopped_at != null ? 'stopped' : r.started_at != null ? 'running' : 'ready',
    created_at: new Date(r.created_at).toISOString()
  }))
}

/** Tests only. */
export function _resetReplayForTests(): void {
  for (const r of runs.values()) for (const t of r.timers) clearTimeout(t)
  runs.clear()
}
