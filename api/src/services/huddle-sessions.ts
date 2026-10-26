import { db } from '../db/index.js'
import { channelByKey, channels, parseRoom } from './chat.js'

/**
 * Huddle sessions (#2849) — what the admin "Huddles" tab in Chat Analytics reads.
 * One session = a room's huddle from the first person in to the last person out.
 * Counts and timings only: no audio, no message text, and DM or group-conversation
 * sessions never keep a room key (the key carries user ids), so nothing in the
 * analytics can name who talked to whom.
 *
 * While a huddle runs, its tallies live in Redis (`<room base>:stats|:users|:q`, plus
 * the tenant's `:live` set of rooms with a huddle) so any replica can finish a session
 * another replica started. When the last person leaves — or the sweep notices a room
 * went quiet without a leave (a crashed browser) — the session is written once:
 * to `nivaro_chat_huddle_sessions` (migration 496) when it exists, otherwise to a
 * capped Redis list, so the feature degrades instead of failing on a database that
 * has not migrated yet.
 */

export type HuddleKind = 'dm' | 'group' | 'channel' | 'general' | 'record'

export interface HuddleSessionRow {
  /** Null for DM and group-conversation sessions (privacy). */
  room: string | null
  kind: HuddleKind
  started_at: string
  ended_at: string
  duration_s: number
  /** Distinct people who were in at some point. */
  participants: number
  peak: number
  screen_shared: boolean
  /** How many leaving browsers sent a quality report. */
  quality_reports: number
  /** Average share (0..1) of a reporting browser's links that ran through the TURN relay. */
  relay_share: number | null
  /** Sum of ICE failures the reporting browsers saw. */
  ice_failed: number
  /** Average packet loss (0..1). */
  avg_loss: number | null
  avg_rtt_ms: number | null
}

/** The slice of ioredis the session tallies use (typed small so tests can fake it). */
export interface SessionRedis {
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>
  del(...keys: string[]): Promise<unknown>
  hset(key: string, field: string, value: string): Promise<unknown>
  hget(key: string, field: string): Promise<string | null>
  hgetall(key: string): Promise<Record<string, string>>
  hincrby(key: string, field: string, by: number): Promise<unknown>
  expire(key: string, seconds: number): Promise<unknown>
  sadd(key: string, ...members: string[]): Promise<unknown>
  srem(key: string, ...members: string[]): Promise<number>
  smembers(key: string): Promise<string[]>
  lpush(key: string, ...values: string[]): Promise<unknown>
  ltrim(key: string, start: number, stop: number): Promise<unknown>
  lrange(key: string, start: number, stop: number): Promise<string[]>
}

/** What a leaving browser reports about its own calls (clamped by `clampQuality`). */
export interface HuddleQuality {
  /** Share of this browser's peer links that used the TURN relay, 0..1. */
  relay_share: number
  /** Links that hit an ICE failure during the call. */
  ice_failed: number
  /** Average inbound packet loss, 0..1; null when nothing was measured. */
  avg_loss: number | null
  /** Average round-trip time in ms; null when nothing was measured. */
  avg_rtt: number | null
}

/** A session never runs longer than this in the tallies (keys expire; a missed end is swept). */
const TALLY_TTL_S = 12 * 3600
/** At most this many quality reports count toward one session. */
const MAX_REPORTS = 64
const FALLBACK_LIST_MAX = 5000
export const RETENTION_DAYS = 180

function num(v: unknown): number | null {
  if (v == null || (typeof v === 'string' && v.trim() === '')) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Validate and clamp a client-sent report (never trusted: relay_share and avg_loss 0..1,
 * ice_failed 0..64, avg_rtt 0..10 000 ms). Returns null when nothing usable arrived.
 */
export function clampQuality(raw: unknown): HuddleQuality | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const relay = num(o.relay_share)
  const failed = num(o.ice_failed)
  const loss = num(o.avg_loss)
  const rtt = num(o.avg_rtt)
  if (relay == null && failed == null && loss == null && rtt == null) return null
  return {
    relay_share: relay == null ? 0 : Math.min(1, Math.max(0, relay)),
    ice_failed: failed == null ? 0 : Math.min(64, Math.max(0, Math.round(failed))),
    avg_loss: loss == null ? null : Math.min(1, Math.max(0, loss)),
    avg_rtt: rtt == null ? null : Math.min(10_000, Math.max(0, Math.round(rtt)))
  }
}

function tenantBase(tenant: string | null, room: string): string {
  return `nvr:huddle:${tenant || '-'}:${room}`
}

function liveKey(tenant: string | null): string {
  return `nvr:huddle:${tenant || '-'}:live`
}

function listKey(tenant: string | null): string {
  return `nvr:huddle:${tenant || '-'}:sessions`
}

// ── Storage ────────────────────────────────────────────────────────────────

export interface SessionStore {
  write(tenant: string | null, row: HuddleSessionRow): Promise<void>
  read(tenant: string | null, since: Date): Promise<HuddleSessionRow[]>
  /** Delete sessions that ended before `before`; returns how many. */
  prune(tenant: string | null, before: Date): Promise<number>
}

const TABLE = 'nivaro_chat_huddle_sessions'
const tableSeen = new Map<string, { at: number; has: boolean }>()

export function resetSessionTableCache(): void {
  tableSeen.clear()
}

async function hasTable(tenant: string | null): Promise<boolean> {
  const key = tenant || '-'
  const hit = tableSeen.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.has
  let has = false
  try {
    has = await db.schema.hasTable(TABLE)
  } catch {
    has = false
  }
  tableSeen.set(key, { at: Date.now(), has })
  return has
}

function toDbRow(r: HuddleSessionRow) {
  return {
    room: r.room,
    kind: r.kind,
    started_at: new Date(r.started_at),
    ended_at: new Date(r.ended_at),
    duration_s: r.duration_s,
    participants: r.participants,
    peak: r.peak,
    screen_shared: r.screen_shared,
    quality_reports: r.quality_reports,
    relay_share: r.relay_share,
    ice_failed: r.ice_failed,
    avg_loss: r.avg_loss,
    avg_rtt_ms: r.avg_rtt_ms
  }
}

function fromDbRow(r: Record<string, unknown>): HuddleSessionRow {
  const f = (v: unknown) => (v == null ? null : Number(v))
  return {
    room: r.room == null ? null : String(r.room),
    kind: String(r.kind) as HuddleKind,
    started_at: new Date(r.started_at as Date).toISOString(),
    ended_at: new Date(r.ended_at as Date).toISOString(),
    duration_s: Number(r.duration_s) || 0,
    participants: Number(r.participants) || 0,
    peak: Number(r.peak) || 0,
    screen_shared: !!r.screen_shared,
    quality_reports: Number(r.quality_reports) || 0,
    relay_share: f(r.relay_share),
    ice_failed: Number(r.ice_failed) || 0,
    avg_loss: f(r.avg_loss),
    avg_rtt_ms: f(r.avg_rtt_ms)
  }
}

export function defaultSessionStore(redis: SessionRedis): SessionStore {
  return {
    async write(tenant, row) {
      if (await hasTable(tenant)) {
        await db(TABLE).insert(toDbRow(row))
        return
      }
      await redis.lpush(listKey(tenant), JSON.stringify(row))
      await redis.ltrim(listKey(tenant), 0, FALLBACK_LIST_MAX - 1)
    },
    async read(tenant, since) {
      if (await hasTable(tenant)) {
        const rows = (await db(TABLE)
          .where('ended_at', '>=', since)
          .orderBy('id', 'desc')
          .limit(20_000)) as Array<Record<string, unknown>>
        return rows.map(fromDbRow)
      }
      const raw = await redis.lrange(listKey(tenant), 0, FALLBACK_LIST_MAX - 1)
      const out: HuddleSessionRow[] = []
      for (const s of raw) {
        try {
          const r = JSON.parse(s) as HuddleSessionRow
          if (new Date(r.ended_at) >= since) out.push(r)
        } catch {
          /* a torn row: skip */
        }
      }
      return out
    },
    async prune(tenant, before) {
      if (await hasTable(tenant)) {
        return Number(await db(TABLE).where('ended_at', '<', before).del()) || 0
      }
      const raw = await redis.lrange(listKey(tenant), 0, FALLBACK_LIST_MAX - 1)
      const keep = raw.filter((s) => {
        try {
          return new Date((JSON.parse(s) as HuddleSessionRow).ended_at) >= before
        } catch {
          return false
        }
      })
      if (keep.length === raw.length) return 0
      await redis.del(listKey(tenant))
      if (keep.length) await redis.lpush(listKey(tenant), ...keep.reverse())
      return raw.length - keep.length
    }
  }
}

// ── Recorder ───────────────────────────────────────────────────────────────

export async function defaultKindOf(room: string): Promise<HuddleKind> {
  const p = parseRoom(room)
  if (p.kind === 'global') return 'general'
  if (p.kind === 'dm') return 'dm'
  if (p.kind === 'channel') {
    try {
      return (await channelByKey(p.channelKey ?? ''))?.is_direct ? 'group' : 'channel'
    } catch {
      return 'channel'
    }
  }
  return 'record'
}

export interface SessionRecorderDeps {
  redis: SessionRedis
  store: SessionStore
  kindOf(room: string): Promise<HuddleKind>
  now?(): number
}

export interface HuddleSessionRecorder {
  /** Someone joined; `size` is how many are in now (them included). */
  joined(tenant: string | null, room: string, userId: string, size: number): Promise<void>
  screenShared(tenant: string | null, room: string): Promise<void>
  quality(tenant: string | null, room: string, q: HuddleQuality): Promise<void>
  /** The room's huddle is over: write the session once. Returns it (null = nothing to write). */
  end(tenant: string | null, room: string): Promise<HuddleSessionRow | null>
  /** Rooms the tenant has a live huddle in (per the tallies, before checking presence). */
  liveRooms(tenant: string | null): Promise<string[]>
  /** End every tallied session whose room has nobody in it any more; returns the sessions ended. */
  sweep(tenant: string | null, isEmpty: (room: string) => Promise<boolean>): Promise<number>
}

export function createSessionRecorder(deps: SessionRecorderDeps): HuddleSessionRecorder {
  const { redis, store } = deps
  const now = () => (deps.now ? deps.now() : Date.now())
  const keys = (tenant: string | null, room: string) => {
    const b = tenantBase(tenant, room)
    return { stats: `${b}:stats`, users: `${b}:users`, q: `${b}:q` }
  }

  const rec: HuddleSessionRecorder = {
    async joined(tenant, room, userId, size) {
      const k = keys(tenant, room)
      // A new huddle in a room whose last one was never closed (a crash the sweep has not
      // reached yet): write the old session out first so the two never merge.
      if (size <= 1 && (await redis.hget(k.stats, 'start'))) await rec.end(tenant, room)
      if (!(await redis.hget(k.stats, 'start'))) {
        await redis.hset(k.stats, 'start', String(now()))
      }
      const peak = Number(await redis.hget(k.stats, 'peak')) || 0
      if (size > peak) await redis.hset(k.stats, 'peak', String(size))
      await redis.hset(k.users, String(userId).toUpperCase(), '1')
      await redis.sadd(liveKey(tenant), room)
      await redis.expire(k.stats, TALLY_TTL_S)
      await redis.expire(k.users, TALLY_TTL_S)
      await redis.expire(liveKey(tenant), TALLY_TTL_S)
    },

    async screenShared(tenant, room) {
      const k = keys(tenant, room)
      if (await redis.hget(k.stats, 'start')) await redis.hset(k.stats, 'screen', '1')
    },

    async quality(tenant, room, q) {
      const k = keys(tenant, room)
      if (!(await redis.hget(k.stats, 'start'))) return
      const n = Number(await redis.hget(k.q, 'n')) || 0
      if (n >= MAX_REPORTS) return
      await redis.hincrby(k.q, 'n', 1)
      await redis.hincrby(k.q, 'relay', Math.round(q.relay_share * 1000))
      await redis.hincrby(k.q, 'failed', q.ice_failed)
      if (q.avg_loss != null) {
        await redis.hincrby(k.q, 'loss', Math.round(q.avg_loss * 10_000))
        await redis.hincrby(k.q, 'lossn', 1)
      }
      if (q.avg_rtt != null) {
        await redis.hincrby(k.q, 'rtt', q.avg_rtt)
        await redis.hincrby(k.q, 'rttn', 1)
      }
      await redis.expire(k.q, TALLY_TTL_S)
    },

    async end(tenant, room) {
      // The set removal is the claim: whichever replica removes the room writes the session.
      const claimed = Number(await redis.srem(liveKey(tenant), room)) > 0
      const k = keys(tenant, room)
      const stats = await redis.hgetall(k.stats)
      const users = await redis.hgetall(k.users)
      const q = await redis.hgetall(k.q)
      await redis.del(k.stats, k.users, k.q)
      const start = Number(stats.start)
      if (!claimed || !Number.isFinite(start) || start <= 0) return null
      const ended = now()
      const kind = await deps.kindOf(room)
      const n = Number(q.n) || 0
      const lossn = Number(q.lossn) || 0
      const rttn = Number(q.rttn) || 0
      const row: HuddleSessionRow = {
        room: kind === 'dm' || kind === 'group' ? null : room,
        kind,
        started_at: new Date(start).toISOString(),
        ended_at: new Date(ended).toISOString(),
        duration_s: Math.max(0, Math.round((ended - start) / 1000)),
        participants: Object.keys(users).length,
        peak: Number(stats.peak) || Object.keys(users).length || 1,
        screen_shared: stats.screen === '1',
        quality_reports: n,
        relay_share: n ? Number(q.relay) / 1000 / n : null,
        ice_failed: Number(q.failed) || 0,
        avg_loss: lossn ? Number(q.loss) / 10_000 / lossn : null,
        avg_rtt_ms: rttn ? Math.round(Number(q.rtt) / rttn) : null
      }
      await store.write(tenant, row)
      return row
    },

    liveRooms(tenant) {
      return redis.smembers(liveKey(tenant))
    },

    async sweep(tenant, isEmpty) {
      let ended = 0
      for (const room of await redis.smembers(liveKey(tenant))) {
        if (!(await isEmpty(room))) continue
        if (await rec.end(tenant, room)) ended++
      }
      return ended
    }
  }
  return rec
}

export function defaultSessionRecorder(redis: SessionRedis): HuddleSessionRecorder {
  return createSessionRecorder({ redis, store: defaultSessionStore(redis), kindOf: defaultKindOf })
}

// ── Analytics (the pure part) ──────────────────────────────────────────────

export interface HuddleAnalytics {
  window: { days: number; from: string; to: string; time_zone: string }
  /** Where the sessions are read from: the table, or the Redis fallback before migration 496. */
  source: 'table' | 'redis'
  live: { huddles: number; people: number }
  totals: {
    huddles: number
    minutes: number
    median_minutes: number | null
    people: number
    screen_share_pct: number | null
    /** Average share of calls' links that ran through TURN, among sessions that reported quality. */
    turn_pct: number | null
    ice_failures: number
    /** Sessions where at least one ICE failure was reported. */
    ice_failure_sessions: number
    avg_loss_pct: number | null
    avg_rtt_ms: number | null
    quality_reports: number
  }
  per_day: Array<{ day: string; huddles: number; minutes: number }>
  busiest_rooms: Array<{
    room: string
    label: string
    kind: 'channel' | 'general' | 'record'
    huddles: number
    minutes: number
  }>
}

function dayKey(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d)
}

function median(sorted: number[]): number | null {
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Weighted mean of per-session averages by their report counts. */
function weighted(rows: HuddleSessionRow[], pick: (r: HuddleSessionRow) => number | null) {
  let sum = 0
  let w = 0
  for (const r of rows) {
    const v = pick(r)
    if (v == null || !r.quality_reports) continue
    sum += v * r.quality_reports
    w += r.quality_reports
  }
  return w ? sum / w : null
}

export function computeHuddleAnalytics(
  rows: HuddleSessionRow[],
  opts: {
    days: number
    from: Date
    to: Date
    timeZone: string
    source: 'table' | 'redis'
    live: { huddles: number; people: number }
    labelOf: (room: string) => string
  }
): HuddleAnalytics {
  const tz = opts.timeZone
  const inWindow = rows.filter((r) => {
    const t = new Date(r.ended_at).getTime()
    return t >= opts.from.getTime() && t <= opts.to.getTime() + 60_000
  })
  const perDay = new Map<string, { huddles: number; seconds: number }>()
  const rooms = new Map<string, { kind: 'channel' | 'general' | 'record'; n: number; s: number }>()
  const durations: number[] = []
  let seconds = 0
  let people = 0
  let screens = 0
  let failures = 0
  let failureSessions = 0
  let reports = 0
  const reporting: HuddleSessionRow[] = []

  for (const r of inWindow) {
    const k = dayKey(new Date(r.ended_at), tz)
    const d = perDay.get(k) ?? { huddles: 0, seconds: 0 }
    d.huddles++
    d.seconds += r.duration_s
    perDay.set(k, d)
    durations.push(r.duration_s)
    seconds += r.duration_s
    people += r.participants
    if (r.screen_shared) screens++
    failures += r.ice_failed
    if (r.ice_failed > 0) failureSessions++
    reports += r.quality_reports
    if (r.quality_reports > 0) reporting.push(r)
    // DM and group sessions carry no room; only channels, General and records are ranked.
    if (r.room && (r.kind === 'channel' || r.kind === 'general' || r.kind === 'record')) {
      const e = rooms.get(r.room) ?? { kind: r.kind, n: 0, s: 0 }
      e.n++
      e.s += r.duration_s
      rooms.set(r.room, e)
    }
  }

  const days: HuddleAnalytics['per_day'] = []
  const cursor = new Date(opts.from)
  const lastKey = dayKey(opts.to, tz)
  for (let i = 0; i < opts.days + 2; i++) {
    const k = dayKey(cursor, tz)
    if (!days.some((d) => d.day === k)) {
      const v = perDay.get(k)
      days.push({
        day: k,
        huddles: v?.huddles ?? 0,
        minutes: v ? Math.round(v.seconds / 60) : 0
      })
    }
    if (k === lastKey) break
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  durations.sort((a, b) => a - b)
  const med = median(durations)
  const relay = weighted(reporting, (r) => r.relay_share)
  const loss = weighted(reporting, (r) => r.avg_loss)
  const rtt = weighted(reporting, (r) => r.avg_rtt_ms)

  return {
    window: {
      days: opts.days,
      from: opts.from.toISOString(),
      to: opts.to.toISOString(),
      time_zone: tz
    },
    source: opts.source,
    live: opts.live,
    totals: {
      huddles: inWindow.length,
      minutes: Math.round(seconds / 60),
      median_minutes: med == null ? null : Math.round((med / 60) * 10) / 10,
      people,
      screen_share_pct: inWindow.length ? Math.round((screens / inWindow.length) * 100) : null,
      turn_pct: relay == null ? null : Math.round(relay * 100),
      ice_failures: failures,
      ice_failure_sessions: failureSessions,
      avg_loss_pct: loss == null ? null : Math.round(loss * 1000) / 10,
      avg_rtt_ms: rtt == null ? null : Math.round(rtt),
      quality_reports: reports
    },
    per_day: days,
    busiest_rooms: [...rooms.entries()]
      .sort((a, b) => b[1].n - a[1].n || b[1].s - a[1].s)
      .slice(0, 10)
      .map(([room, v]) => ({
        room,
        label: opts.labelOf(room),
        kind: v.kind,
        huddles: v.n,
        minutes: Math.round(v.s / 60)
      }))
  }
}

/** Retention: sessions older than this are pruned by the nightly cron. */
export function retentionCutoff(now = Date.now()): Date {
  return new Date(now - RETENTION_DAYS * 24 * 3600_000)
}

/** The admin read: sessions in the window, plus who is in a huddle right now. */
export async function loadHuddleAnalytics(
  redis: SessionRedis & {
    zrange(key: string, start: number, stop: number): Promise<string[]>
    zremrangebyscore(key: string, min: number | string, max: number | string): Promise<unknown>
    hgetall(key: string): Promise<Record<string, string>>
  },
  tenant: string | null,
  days: number,
  timeZone: string,
  peersIn: (room: string) => Promise<Array<{ user: string }>>
): Promise<HuddleAnalytics> {
  const to = new Date()
  const from = new Date(to.getTime() - days * 24 * 3600_000)
  const store = defaultSessionStore(redis)
  const rows = await store.read(tenant, from)
  const rec = createSessionRecorder({ redis, store, kindOf: defaultKindOf })
  let huddles = 0
  let people = 0
  for (const room of await rec.liveRooms(tenant)) {
    const peers = await peersIn(room)
    if (!peers.length) continue
    huddles++
    people += new Set(peers.map((p) => p.user)).size
  }
  const chans = await channels()
  const labelOf = (room: string): string => {
    const p = parseRoom(room)
    if (p.kind === 'global') return 'General'
    if (p.kind === 'channel') return chans.get(p.channelKey ?? '')?.name ?? room
    const colon = room.indexOf(':')
    return colon > 0 ? room.slice(colon + 1).toUpperCase() : room
  }
  return computeHuddleAnalytics(rows, {
    days,
    from,
    to,
    timeZone,
    source: (await hasTable(tenant)) ? 'table' : 'redis',
    live: { huddles, people },
    labelOf
  })
}
