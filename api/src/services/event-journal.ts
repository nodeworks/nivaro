import type { Redis } from 'ioredis'
import { getIo } from './io-holder.js'

/**
 * Missed-event catch-up (#266): every journaled emit gets a global sequence
 * number and lands in a Redis sorted set (score = seq). A reconnecting client
 * sends its last-seen cursor; the server replays the events for rooms that
 * socket has (re)joined instead of the client refetching everything. Redis-
 * backed so multi-replica emits share one sequence and one journal.
 *
 * The journal is bounded (JOURNAL_MAX entries, JOURNAL_TTL) — a cursor older
 * than the window gets `full: true`, meaning "I can't reconstruct; do your
 * old invalidate-everything".
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

export interface JournalEntry {
  seq: number
  room: string
  event: string
  payload: Record<string, unknown>
}

/**
 * Emit to a room with a sequence number, journaling the event. Falls back to
 * a plain emit when Redis is unavailable — delivery beats replayability.
 */
export async function journaledEmit(
  room: string,
  event: string,
  payload: Record<string, unknown>
): Promise<void> {
  const io = getIo()
  if (!io) return
  let seq: number | null = null
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
  io.to(room).emit(event, seq == null ? payload : { ...payload, _seq: seq })
}

/** Replay events after `cursor` for the given rooms. */
export async function replaySince(
  cursor: number,
  rooms: Set<string>
): Promise<{ full: boolean; events: JournalEntry[] }> {
  if (!_redis) return { full: true, events: [] }
  try {
    // If the oldest retained seq is beyond the cursor+1, we lost events.
    const oldest = await _redis.zrange(JOURNAL_KEY, 0, 0, 'WITHSCORES')
    const oldestSeq = oldest.length >= 2 ? Number(oldest[1]) : null
    if (oldestSeq != null && cursor + 1 < oldestSeq) return { full: true, events: [] }
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
          if (events.length >= REPLAY_CAP) break
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

/** Current sequence (diagnostics). */
export async function currentSeq(): Promise<number | null> {
  try {
    const v = await _redis?.get(SEQ_KEY)
    return v ? Number(v) : 0
  } catch {
    return null
  }
}
