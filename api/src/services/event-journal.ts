import type { Redis } from 'ioredis'
import {
  flushDurable,
  maxDurableSeq,
  recordDurable,
  replayFromTable
} from './event-journal-store.js'
import { publishToStream, streamActive } from './event-stream.js'
import { getIo } from './io-holder.js'
import { tenantScopedRoom } from './tenant-rooms.js'

/**
 * Missed-event catch-up (#266): every journaled emit gets a global sequence
 * number and lands in a Redis sorted set (score = seq). A reconnecting client
 * sends its last-seen cursor; the server replays the events for rooms that
 * socket has (re)joined instead of the client refetching everything. Redis-
 * backed so multi-replica emits share one sequence and one journal.
 *
 * The journal is bounded (JOURNAL_MAX entries, JOURNAL_TTL). A cursor older
 * than that window is answered from the durable table (#1673, 24 hours —
 * event-journal-store.ts); only a cursor older than THAT gets `full: true`,
 * meaning "I can't reconstruct; do your old invalidate-everything".
 *
 * Cross-replica delivery (#1737): a journaled event is emitted to this
 * process's sockets and carried to the other replicas on a Redis stream
 * (event-stream.ts) instead of the adapter's pub/sub, so a replica that lost
 * Redis for a moment resumes from its offset.
 */

const SEQ_KEY = 'nvr:ev:seq'
const JOURNAL_KEY = 'nvr:ev:journal'
const JOURNAL_MAX = 5000
const JOURNAL_TTL_S = 900
const REPLAY_CAP = 500

let _redis: Redis | null = null
export function setJournalRedis(redis: Redis): void {
  _redis = redis
}

/** Traffic Map realtime health (#1101): how long each emit spent journaling, and whether it did. */
type JournalObserver = (ms: number, journaled: boolean) => void
let observer: JournalObserver | null = null
export function setJournalObserver(fn: JournalObserver | null): void {
  observer = fn
}

export interface JournalEntry {
  seq: number
  room: string
  event: string
  payload: Record<string, unknown>
}

export interface EmitResult {
  seq: number | null
  /** How it left this process: 'stream' (local + Redis stream), 'adapter' (pub/sub). */
  path: 'stream' | 'adapter' | 'none'
  /** The room it went to — tenant-prefixed in a tenant's context (tenant-rooms.ts). */
  room: string
}

/**
 * Emit to a room with a sequence number, journaling the event. Falls back to
 * a plain emit when Redis is unavailable — delivery beats replayability.
 *
 * `selfViaStream` (delivery probe only) skips the local emit and lets this
 * replica's own stream reader deliver it, so the probe measures the path an
 * event from another replica takes.
 *
 * Cloud mode: inside a tenant's context the room is that tenant's
 * (`t:<tenant>:<room>`), so the live emit, the stream entry and both journals
 * carry the tenant and only that tenant's sockets can receive or replay it.
 */
export async function journaledEmit(
  roomName: string,
  event: string,
  payload: Record<string, unknown>,
  /** `roomScoped`: the caller already applied tenantScopedRoom (the probe, whose
   *  socket callbacks may not carry the tenant context it started in). */
  opts: { selfViaStream?: boolean; roomScoped?: boolean } = {}
): Promise<EmitResult> {
  const room = opts.roomScoped ? roomName : tenantScopedRoom(roomName)
  const io = getIo()
  if (!io) return { seq: null, path: 'none', room }
  let seq: number | null = null
  const t0 = observer ? performance.now() : 0
  try {
    if (_redis) {
      seq = await _redis.incr(SEQ_KEY)
      const entry: JournalEntry = { seq, room, event, payload }
      await _redis
        .multi()
        .zadd(JOURNAL_KEY, seq, JSON.stringify(entry))
        .zremrangebyrank(JOURNAL_KEY, 0, -(JOURNAL_MAX + 1))
        .expire(JOURNAL_KEY, JOURNAL_TTL_S)
        .exec()
    }
  } catch {
    seq = null // Redis down — emit unjournaled (fail open)
  }
  const out = seq == null ? payload : { ...payload, _seq: seq }
  let path: EmitResult['path'] = 'adapter'
  if (seq != null) {
    const entry: JournalEntry = { seq, room, event, payload }
    recordDurable(entry) // #1673 — buffered, never awaited
    // #1737 — stream first; the local emit only once the other replicas will hear it.
    if (streamActive() && (await publishToStream(entry, { self: opts.selfViaStream }))) {
      path = 'stream'
      if (!opts.selfViaStream) io.local.to(room).emit(event, out)
    }
  }
  // No sequence, no stream, or the append failed: the adapter's pub/sub as before.
  if (path === 'adapter') io.to(room).emit(event, out)
  if (observer) {
    try {
      observer(performance.now() - t0, seq != null)
    } catch {
      /* a diagnostic never affects delivery */
    }
  }
  return { seq, path, room }
}

/** Replay events after `cursor` for the given rooms. */
export async function replaySince(
  cursor: number,
  rooms: Set<string>
): Promise<{ full: boolean; events: JournalEntry[] }> {
  const fromRedis = await replayFromRedis(cursor, rooms)
  if (!fromRedis.full) return fromRedis
  // Older than the Redis window, or Redis unavailable: the durable table (#1673).
  return replayFromTable(cursor, rooms, REPLAY_CAP)
}

async function replayFromRedis(
  cursor: number,
  rooms: Set<string>
): Promise<{ full: boolean; events: JournalEntry[] }> {
  if (!_redis) return { full: true, events: [] }
  try {
    // If the oldest retained seq is beyond the cursor+1, we lost events.
    const oldest = await _redis.zrange(JOURNAL_KEY, 0, 0, 'WITHSCORES')
    const oldestSeq = oldest.length >= 2 ? Number(oldest[1]) : null
    if (oldestSeq != null && cursor + 1 < oldestSeq) return { full: true, events: [] }
    if (oldestSeq == null) {
      // The journal key expired after a quiet spell. Anything after the cursor
      // happened more than JOURNAL_TTL ago — not "nothing happened".
      const current = Number((await _redis.get(SEQ_KEY)) ?? 0)
      return current > cursor ? { full: true, events: [] } : { full: false, events: [] }
    }
    const raw = await _redis.zrangebyscore(
      JOURNAL_KEY,
      `(${cursor}`,
      '+inf',
      'LIMIT',
      0,
      REPLAY_CAP * 4
    )
    const events: JournalEntry[] = []
    for (const r of raw) {
      try {
        const e = JSON.parse(r) as JournalEntry
        if (rooms.has(e.room)) {
          events.push(e)
          // More than one replay carries — reload rather than replay a part.
          if (events.length > REPLAY_CAP) return { full: true, events: [] }
        }
      } catch {
        // skip corrupt entry
      }
    }
    return { full: false, events }
  } catch {
    return { full: true, events: [] }
  }
}

/**
 * Keep the sequence ahead of the durable table (#1673). If Redis lost its
 * keys (flush, failover to an empty node) the counter restarts at 1 while the
 * table still holds higher numbers, and a client's cursor would hide new
 * events behind old ones. Called once at boot; never lowers the counter.
 */
export async function alignJournalSequence(): Promise<number | null> {
  if (!_redis) return null
  try {
    const max = await maxDurableSeq()
    if (max == null) return null
    await _redis.eval(
      "local c = tonumber(redis.call('GET', KEYS[1]) or '0') if c < tonumber(ARGV[1]) then redis.call('SET', KEYS[1], ARGV[1]) end return 1",
      1,
      SEQ_KEY,
      String(max)
    )
    return max
  } catch {
    return null
  }
}

/** Flush buffered durable rows (shutdown, probes). */
export async function flushJournal(): Promise<void> {
  await flushDurable()
}

/** Current sequence (diagnostics). */
export async function currentSeq(): Promise<number | null> {
  try {
    const v = await _redis?.get(SEQ_KEY)
    return v ? Number(v) : 0
  } catch {
    return null
  }
}
