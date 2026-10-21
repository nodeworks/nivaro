import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import type { JournalEntry } from './event-journal.js'
import { getIo } from './io-holder.js'
import { notifyJournalListeners } from './journal-listeners.js'
import { ackSampled } from './realtime-ack-sample.js'
import { livePayload } from './socket-transport.js'
import { noteAdapterLag } from './traffic-taps/realtime.js'

/**
 * Cross-replica realtime events on a Redis stream (#1737).
 *
 * The Socket.io Redis adapter rides pub/sub: anything published while a
 * replica is disconnected from Redis is gone for that replica's clients.
 * Journaled events (record changes) travel on a stream instead — each
 * replica reads it from its own last offset, so a replica back from a blip
 * resumes where it stopped and its clients miss nothing.
 *
 * The replica that makes the write emits to its own sockets at once
 * (`io.local`) and appends to the stream; every replica's reader emits the
 * entries written by OTHER replicas to its local sockets. Everything else the
 * app emits (presence, typing, notifications) still rides the adapter.
 *
 * Trimmed to the event journal's window (5,000 entries, 15 minutes).
 * `REALTIME_EVENT_STREAM=off` keeps the old adapter path. When Redis is
 * unavailable at emit time the caller falls back to the adapter, so delivery
 * never depends on the stream being up.
 *
 * Rolling deploys: a replica still on an older build does not read the
 * stream, so its clients miss events from newer replicas until it is
 * replaced (they then reconnect and catch up from the journal).
 */

const STREAM_KEY = 'nvr:ev:stream'
export const STREAM_MAXLEN = 5000
const STREAM_WINDOW_MS = 900_000
const READ_COUNT = 500
const BLOCK_MS = 5000
const RETRY_MS = 1000
const NODE = randomUUID()

let pub: Redis | null = null
let reader: Redis | null = null
let running = false
let lastId = '$'
let trimTimer: ReturnType<typeof setInterval> | null = null

const stats = {
  published: 0,
  publishFailed: 0,
  delivered: 0,
  ownSkipped: 0,
  readErrors: 0,
  resumes: 0,
  /** Entries delivered by the read that followed a Redis error (the "missed nothing" proof). */
  lastResumeBacklog: 0,
  lastDeliveryLagMs: null as number | null,
  lastError: null as string | null,
  lastErrorAt: null as string | null
}

export function streamEnabled(): boolean {
  return String(process.env.REALTIME_EVENT_STREAM ?? 'on').toLowerCase() !== 'off'
}

/** True when the stream path is live in this process. */
export function streamActive(): boolean {
  return running && pub != null
}

/** Field list for XADD: node, self-delivery flag, write time, entry JSON. Exported for tests. */
export function encodeStreamEntry(
  entry: JournalEntry,
  opts: { self?: boolean; node?: string; at?: number } = {}
): string[] {
  return [
    'n',
    opts.node ?? NODE,
    's',
    opts.self ? '1' : '0',
    't',
    String(opts.at ?? Date.now()),
    'e',
    JSON.stringify(entry)
  ]
}

export interface DecodedStreamEntry {
  node: string
  self: boolean
  at: number
  entry: JournalEntry
}

/** Parse XREAD field pairs back. Null for a malformed entry. Exported for tests. */
export function decodeStreamEntry(fields: string[]): DecodedStreamEntry | null {
  const map = new Map<string, string>()
  for (let i = 0; i + 1 < fields.length; i += 2) map.set(fields[i], fields[i + 1])
  const raw = map.get('e')
  if (!raw) return null
  try {
    const entry = JSON.parse(raw) as JournalEntry
    if (!entry || typeof entry.room !== 'string' || typeof entry.event !== 'string') return null
    return {
      node: map.get('n') ?? '',
      self: map.get('s') === '1',
      at: Number(map.get('t')) || 0,
      entry
    }
  } catch {
    return null
  }
}

/** Should this replica emit an entry? Its own writes were emitted locally already. */
export function shouldDeliver(d: DecodedStreamEntry, node: string = NODE): boolean {
  return d.node !== node || d.self
}

/**
 * Append a journaled event to the stream. `self` asks this replica's reader to
 * deliver it too (the delivery probe uses it to test the whole path).
 * Resolves false when the stream is not available — the caller falls back.
 */
export async function publishToStream(
  entry: JournalEntry,
  /** `at`: the write time to record (a sampled event's `_st`, #2477); default now. */
  opts: { self?: boolean; at?: number } = {}
): Promise<boolean> {
  if (!streamActive() || !pub) return false
  try {
    await pub.xadd(
      STREAM_KEY,
      'MAXLEN',
      '~',
      String(STREAM_MAXLEN),
      '*',
      ...encodeStreamEntry(entry, opts)
    )
    stats.published++
    return true
  } catch (err) {
    stats.publishFailed++
    stats.lastError = err instanceof Error ? err.message.slice(0, 200) : String(err)
    stats.lastErrorAt = new Date().toISOString()
    return false
  }
}

function deliver(d: DecodedStreamEntry): void {
  const io = getIo()
  if (!io) return
  const { entry } = d
  const live = livePayload(entry)
  // #2477 — a sampled event carries the time it was written, for client acknowledgements.
  const payload = entry.seq != null && ackSampled(entry.seq) && d.at ? { ...live, _st: d.at } : live
  io.local.to(entry.room).emit(entry.event, payload)
  stats.delivered++
  if (d.at) {
    stats.lastDeliveryLagMs = Math.max(0, Date.now() - d.at)
    // Traffic Map (#2266): only entries another replica wrote say anything about the hop.
    if (d.node !== NODE) noteAdapterLag(stats.lastDeliveryLagMs)
  }
}

type XReadReply = Array<[string, Array<[string, string[]]>]> | null

async function readLoop(): Promise<void> {
  let afterError = false
  while (running && reader) {
    try {
      const reply = (await reader.xread(
        'COUNT',
        String(READ_COUNT),
        'BLOCK',
        String(BLOCK_MS),
        'STREAMS',
        STREAM_KEY,
        lastId
      )) as XReadReply
      let count = 0
      for (const [, entries] of reply ?? []) {
        for (const [id, fields] of entries) {
          lastId = id
          count++
          const d = decodeStreamEntry(fields)
          if (!d) continue
          if (!shouldDeliver(d)) {
            stats.ownSkipped++
            continue
          }
          try {
            deliver(d)
          } catch {
            /* one bad emit never stops the reader */
          }
          // #1675 / #1680 — another replica's write, for pushed widgets and saved-view streams
          // (this replica's own writes reached them from journaledEmit).
          if (d.node !== NODE) notifyJournalListeners(d.entry)
        }
      }
      if (afterError) {
        stats.resumes++
        stats.lastResumeBacklog = count
        afterError = false
      }
    } catch (err) {
      if (!running) break
      stats.readErrors++
      stats.lastError = err instanceof Error ? err.message.slice(0, 200) : String(err)
      stats.lastErrorAt = new Date().toISOString()
      afterError = true
      // Keep lastId: the next read resumes after the last entry handled.
      await new Promise((r) => setTimeout(r, RETRY_MS))
    }
  }
}

/** Drop entries older than the journal window (MINID needs Redis 6.2 — best effort). */
async function trimByAge(): Promise<void> {
  if (!pub) return
  try {
    await pub.xtrim(STREAM_KEY, 'MINID', '~', String(Date.now() - STREAM_WINDOW_MS))
  } catch {
    /* older Redis: MAXLEN on every XADD still bounds the stream */
  }
}

/**
 * Start the reader. The offset starts at the newest entry present now: a
 * process that just booted has no sockets that could have missed anything
 * older — its clients reconnect and catch up from the journal.
 */
export async function initEventStream(redis: Redis): Promise<boolean> {
  if (running || !streamEnabled()) return running
  try {
    const conn = redis.duplicate()
    conn.on('error', () => {})
    const newest = (await redis.xrevrange(STREAM_KEY, '+', '-', 'COUNT', 1)) as Array<
      [string, string[]]
    >
    lastId = newest?.[0]?.[0] ?? '0-0'
    pub = redis
    reader = conn
    running = true
    void readLoop()
    trimTimer = setInterval(() => void trimByAge(), 60_000)
    trimTimer.unref?.()
    return true
  } catch {
    pub = null
    reader = null
    running = false
    return false
  }
}

export async function closeEventStream(): Promise<void> {
  running = false
  if (trimTimer) clearInterval(trimTimer)
  trimTimer = null
  const conn = reader
  reader = null
  pub = null
  if (conn) conn.disconnect()
}

export function eventStreamStats(): typeof stats & {
  enabled: boolean
  active: boolean
  node: string
  last_id: string
} {
  return { ...stats, enabled: streamEnabled(), active: streamActive(), node: NODE, last_id: lastId }
}

export function streamNodeId(): string {
  return NODE
}
