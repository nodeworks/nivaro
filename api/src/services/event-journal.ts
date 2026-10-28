import { createHash, randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import {
  flushDurable,
  maxDurableSeq,
  recordDurable,
  replayFromTable
} from './event-journal-store.js'
import {
  notePublishedToStream,
  publishToStream,
  STREAM_KEY,
  streamActive,
  streamMaxLen,
  streamNodeId
} from './event-stream.js'
import { getIo } from './io-holder.js'
import { notifyJournalListeners } from './journal-listeners.js'
import {
  ACK_STAMP_TTL_S,
  ackEvery,
  ackStampKey,
  localRoomSize,
  noteStampedDelivery,
  shouldStamp
} from './realtime-ack-sample.js'
import { livePayload } from './socket-transport.js'
import { currentTenantKey, tenantScopedRoom } from './tenant-rooms.js'

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
 *
 * One atomic step per event (review 2026-10-27): the sequence numbers, the journal entry, the
 * ack stamp and the stream append run as ONE Lua script — one round trip instead of three, and
 * the stream order is the sequence order. With the sequence taken first and the XADD later, two
 * replicas could append 11 before 10, and a client that already held 11 skipped 10.
 * REALTIME_ATOMIC_EMIT=off keeps the old multi + XADD steps.
 *
 * Journal size: REALTIME_JOURNAL_MAX entries (default 5000; the stream follows it). A bulk write
 * past the window sends every reconnecting client to the durable table or a full reload.
 */

const SEQ_KEY = 'nvr:ev:seq'
const JOURNAL_KEY = 'nvr:ev:journal'
const JOURNAL_TTL_S = 900
const REPLAY_CAP = 500

/** Entries the Redis journal keeps (REALTIME_JOURNAL_MAX, default 5000, 1000–200000). */
export function journalMax(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.REALTIME_JOURNAL_MAX)
  if (!Number.isFinite(n) || n <= 0) return 5000
  return Math.min(200_000, Math.max(1000, Math.floor(n)))
}

/** The one-step emit (REALTIME_ATOMIC_EMIT, on unless `off`). */
export function atomicEmitOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.REALTIME_ATOMIC_EMIT ?? 'on').toLowerCase() !== 'off'
}

/**
 * KEYS: seq, room seq, journal, stream. ARGV: room, event, payload JSON, journal max, journal
 * TTL, room-seq TTL, ack every, floor stamp (1/0), now, stream on (1/0), stream max length,
 * node, self (1/0), ack stamp key prefix, ack stamp TTL. The entry JSON keeps JournalEntry's
 * field order. The XADD runs under pcall: a refused append leaves the journaled event to go
 * out on the adapter (streamed = 0), never half a script.
 */
export const EMIT_SCRIPT = `
local seq = redis.call('INCR', KEYS[1])
local rseq = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[6]))
local entry = '{"seq":' .. seq .. ',"room":' .. cjson.encode(ARGV[1]) .. ',"event":' ..
  cjson.encode(ARGV[2]) .. ',"payload":' .. ARGV[3] .. ',"rseq":' .. rseq .. '}'
redis.call('ZADD', KEYS[3], seq, entry)
redis.call('ZREMRANGEBYRANK', KEYS[3], 0, -(tonumber(ARGV[4]) + 1))
redis.call('EXPIRE', KEYS[3], tonumber(ARGV[5]))
local every = tonumber(ARGV[7])
local stamped = 0
if every > 0 and (ARGV[8] == '1' or seq % every == 0) then
  stamped = 1
  redis.call('SET', ARGV[14] .. seq, ARGV[9], 'EX', tonumber(ARGV[15]))
end
local streamed = 0
if ARGV[10] == '1' then
  local ok
  if stamped == 1 then
    ok = pcall(redis.call, 'XADD', KEYS[4], 'MAXLEN', '~', ARGV[11], '*',
      'n', ARGV[12], 's', ARGV[13], 't', ARGV[9], 'e', entry, 'k', '1')
  else
    ok = pcall(redis.call, 'XADD', KEYS[4], 'MAXLEN', '~', ARGV[11], '*',
      'n', ARGV[12], 's', ARGV[13], 't', ARGV[9], 'e', entry)
  end
  if ok then streamed = 1 end
end
return {seq, rseq, stamped, streamed}
`
const EMIT_SHA = createHash('sha1').update(EMIT_SCRIPT).digest('hex')
/** Set once the script failed 3 times where the plain steps then worked (a Redis or proxy
 *  without EVAL): this process stops asking it. */
let emitScriptUnusable = false
let emitScriptMisses = 0

/** Tests only. */
export function _resetEmitScriptForTests(): void {
  emitScriptUnusable = false
  emitScriptMisses = 0
}

type ScriptRedis = {
  evalsha(sha: string, numKeys: number, ...args: string[]): Promise<unknown>
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>
}

async function runEmitScript(
  redis: ScriptRedis,
  keys: string[],
  args: string[]
): Promise<number[]> {
  let out: unknown
  try {
    out = await redis.evalsha(EMIT_SHA, keys.length, ...keys, ...args)
  } catch (err) {
    if (!/NOSCRIPT/i.test(err instanceof Error ? err.message : String(err))) throw err
    out = await redis.eval(EMIT_SCRIPT, keys.length, ...keys, ...args)
  }
  if (!Array.isArray(out)) throw new Error('emit script answered nothing')
  return out.map((v) => Number(v))
}
/** #2462 — one counter per room (`nvr:ev:rseq:<room>`), dropped after an hour without events. */
const ROOM_SEQ_PREFIX = 'nvr:ev:rseq:'
const ROOM_SEQ_TTL_S = 3600

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
  /** #2462 — the room's own sequence number (absent on entries written before it existed). */
  rseq?: number
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
  let rseq: number | null = null
  // #2477 — a sampled event carries the time it left (`_st`), for the clients' delivery
  // acknowledgements; the server keeps the stamp so an ack can only echo a real one.
  let st: number | null = null
  const t0 = observer ? performance.now() : 0
  /** Set when the one-step script already appended the entry to the stream. */
  let streamedInScript: boolean | null = null
  const scriptable =
    _redis &&
    !emitScriptUnusable &&
    atomicEmitOn() &&
    typeof (_redis as unknown as Partial<ScriptRedis>).evalsha === 'function' &&
    typeof (_redis as unknown as Partial<ScriptRedis>).eval === 'function'
  let scriptFailed = false
  /** A floor stamp the script was asked to make: the plain steps make it instead if it failed. */
  let floorTaken = false
  if (_redis && scriptable) {
    try {
      const now = Date.now()
      // A floor stamp (or every event, at REALTIME_ACK_EVERY=1) is decided here; 1 in N by
      // sequence inside the script, where the sequence is known.
      const floorStamp = shouldStamp(1, { now, floor: !opts.selfViaStream && !opts.roomScoped })
      floorTaken = floorStamp
      const streamOn = streamActive()
      const [s0, r0, stamped, streamed] = await runEmitScript(
        _redis as unknown as ScriptRedis,
        [SEQ_KEY, `${ROOM_SEQ_PREFIX}${room}`, JOURNAL_KEY, STREAM_KEY],
        [
          room,
          event,
          JSON.stringify(payload),
          String(journalMax()),
          String(JOURNAL_TTL_S),
          String(ROOM_SEQ_TTL_S),
          String(ackEvery()),
          floorStamp ? '1' : '0',
          String(now),
          streamOn ? '1' : '0',
          String(streamMaxLen()),
          streamNodeId(),
          opts.selfViaStream ? '1' : '0',
          ackStampKey(0).slice(0, -1),
          String(ACK_STAMP_TTL_S)
        ]
      )
      seq = s0
      if (!Number.isFinite(seq) || seq <= 0) throw new Error('no sequence')
      if (Number.isFinite(r0) && r0 > 0) rseq = r0
      if (stamped === 1) {
        st = now
        // A sequence-sampled stamp restarts the floor clock too, as before.
        if (!floorStamp) shouldStamp(seq, { now, floor: false })
      }
      if (streamOn) {
        streamedInScript = streamed === 1
        notePublishedToStream(streamedInScript)
      }
    } catch {
      scriptFailed = true
      seq = null
      rseq = null
      st = null
      streamedInScript = null
    }
  }
  if (_redis && seq == null) {
    try {
      // #2462 — the global position and this room's own counter in one transaction, so the
      // room sequence follows the global order. A connected client that sees a room's counter
      // skip knows it missed an event there and catches that room up alone.
      const rkey = `${ROOM_SEQ_PREFIX}${room}`
      const counted = await _redis
        .multi()
        .incr(SEQ_KEY)
        .incr(rkey)
        .expire(rkey, ROOM_SEQ_TTL_S)
        .exec()
      seq = Number(counted?.[0]?.[1])
      const r = Number(counted?.[1]?.[1])
      if (!Number.isFinite(seq) || seq <= 0) throw new Error('no sequence')
      if (Number.isFinite(r) && r > 0) rseq = r
      const entry: JournalEntry = { seq, room, event, payload, ...(rseq ? { rseq } : {}) }
      const m = _redis
        .multi()
        .zadd(JOURNAL_KEY, seq, JSON.stringify(entry))
        .zremrangebyrank(JOURNAL_KEY, 0, -(journalMax() + 1))
        .expire(JOURNAL_KEY, JOURNAL_TTL_S)
      // 1 in N by sequence, or this process's first event after the time floor; never the
      // floor for synthetic emits (the probe, drills), whose sockets are not people.
      if (floorTaken || shouldStamp(seq, { floor: !opts.selfViaStream && !opts.roomScoped })) {
        st = Date.now()
        m.set(ackStampKey(seq), String(st), 'EX', ACK_STAMP_TTL_S)
      }
      await m.exec()
      // The script failed where the plain steps work: after a few of those, stop asking it.
      if (scriptFailed && ++emitScriptMisses >= 3) emitScriptUnusable = true
    } catch {
      seq = null // Redis down — emit unjournaled (fail open)
      rseq = null
      st = null
      streamedInScript = null
    }
  }
  // `_room` is the room as the client joined it (tenant prefix off), so it can key its counter.
  const live =
    seq == null ? payload : livePayload({ seq, room, event, payload, ...(rseq ? { rseq } : {}) })
  const out = st != null ? { ...live, _st: st } : live
  let path: EmitResult['path'] = 'adapter'
  if (seq != null) {
    const entry: JournalEntry = { seq, room, event, payload, ...(rseq ? { rseq } : {}) }
    recordDurable(entry) // #1673 — buffered, never awaited
    // #1737 — stream first; the local emit only once the other replicas will hear it.
    // The stream entry's write time is the stamp, so other replicas send the same `_st`.
    const pub = { self: opts.selfViaStream, ...(st != null ? { at: st, stamped: true } : {}) }
    const streamed =
      streamedInScript != null
        ? streamedInScript
        : streamActive() && (await publishToStream(entry, pub))
    if (streamed) {
      path = 'stream'
      if (!opts.selfViaStream) {
        io.local.to(room).emit(event, out)
        if (st != null) noteStampedDelivery(_redis, room, localRoomSize(io, room))
      }
    }
  }
  // No sequence, no stream, or the append failed: the adapter's pub/sub as before.
  if (path === 'adapter') {
    io.to(room).emit(event, out)
    // Only this process's own sockets are counted; other processes' are not visible here.
    if (st != null) noteStampedDelivery(_redis, room, localRoomSize(io, room))
    // Post-mortem 3.3 — the other processes' journal listeners (saved-view and SSE streams,
    // pushed widgets, MCP live sessions) hear stream entries only; on this path they hear it on
    // a plain Redis channel every process subscribes to (SOCKETS=off ones included).
    if (seq != null && typeof _redis?.publish === 'function')
      void Promise.resolve()
        .then(() =>
          _redis?.publish(
            fallbackChannel(),
            JSON.stringify({
              node: FALLBACK_NODE,
              at: Date.now(),
              entry: { seq, room, event, payload }
            })
          )
        )
        .catch(() => {})
  }
  // #1675 / #1680 — pushed widgets and saved-view streams hear this process's own writes here.
  if (!opts.selfViaStream) notifyJournalListeners({ seq, room, event, payload })
  if (observer) {
    try {
      observer(performance.now() - t0, seq != null)
    } catch {
      /* a diagnostic never affects delivery */
    }
  }
  return { seq, path, room }
}

/** Redis channel carrying journal entries that went out without the event stream. */
export const fallbackChannel = () => `${process.env.REDIS_CHANNEL_PREFIX ?? ''}nvr:journal-fallback`
const FALLBACK_NODE = randomUUID()

/** One fallback message for this process's listeners (its own messages are skipped). */
export function receiveJournalFallback(raw: string): void {
  let msg: { node?: unknown; at?: unknown; entry?: Partial<JournalEntry> } | null = null
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }
  const entry = msg?.entry
  if (!entry || msg?.node === FALLBACK_NODE) return
  if (typeof entry.room !== 'string' || typeof entry.event !== 'string') return
  notifyJournalListeners(
    {
      seq: typeof entry.seq === 'number' ? entry.seq : null,
      room: entry.room,
      event: entry.event,
      payload: (entry.payload as Record<string, unknown>) ?? {}
    },
    'remote',
    typeof msg?.at === 'number' ? msg.at : undefined
  )
}

let fallbackSub: Redis | null = null

/** Subscribe this process to the fallback channel. Idempotent; returns the stop function. */
export function wireJournalFallback(redis: Redis | null | undefined): () => Promise<void> {
  if (!redis || fallbackSub) return async () => {}
  const sub = redis.duplicate()
  fallbackSub = sub
  sub.on('error', () => {
    /* reconnects on its own; the stream is the main path */
  })
  sub.on('message', (channel: string, raw: string) => {
    if (channel === fallbackChannel()) receiveJournalFallback(raw)
  })
  void sub.subscribe(fallbackChannel()).catch(() => {})
  return async () => {
    if (fallbackSub !== sub) return
    fallbackSub = null
    await sub.quit().catch(() => sub.disconnect())
  }
}

/** Replay events after `cursor` for the given rooms. */
export async function replaySince(
  cursor: number,
  rooms: Set<string>
): Promise<{ full: boolean; events: JournalEntry[] }> {
  const fromRedis = await replayFromRedis(cursor, rooms)
  if (!fromRedis.full) return fromRedis
  // Older than the Redis window, or Redis unavailable: the durable table (#1673), a few at a
  // time — after a deploy every reconnecting tab may land here at once.
  return withTableSlot(() => replayFromTable(cursor, rooms, REPLAY_CAP))
}

// ── Shared journal reads (review 2026-10-27) ────────────────────────────────
// After a deploy every tab reconnects within a few seconds holding nearly the same cursor.
// Each catch-up used to read the journal on its own (3 Redis calls and up to 2,000 entries
// parsed, per tab). Catch-ups whose cursors fall in one bucket now wait REPLAY_BATCH_MS for
// each other and share ONE read from the lowest cursor; each filters its own rooms and cursor.
// Only callers that joined BEFORE the read ran share it: a caller calls replaySince once its
// joins have landed, so the shared read still sees every event its rooms could have missed.

const REPLAY_BUCKET = 64

/** How long a catch-up waits for others to share its read (REALTIME_REPLAY_BATCH_MS, default
 *  25, 0 = read alone). */
export function replayBatchMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.REALTIME_REPLAY_BATCH_MS
  if (raw == null || raw === '') return 25
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.min(500, Math.floor(n)) : 25
}

interface JournalWindow {
  /** Oldest retained sequence, null when the journal key is gone. */
  oldestSeq: number | null
  /** The global counter (read only when the journal key is gone). */
  current: number
  /** Parsed entries after the read's cursor, in order. */
  entries: JournalEntry[]
}

interface PendingRead {
  minCursor: number
  promise: Promise<JournalWindow>
}

const pendingReads = new WeakMap<object, Map<string, PendingRead>>()
const replayStats = { reads: 0, shared: 0 }

/** Journal reads made, and catch-ups that shared another's read (diagnostics, tests). */
export function replayReadStats(): { reads: number; shared: number } {
  return { ...replayStats }
}

async function readJournalWindow(redis: Redis, cursor: number): Promise<JournalWindow> {
  replayStats.reads++
  const oldest = await redis.zrange(JOURNAL_KEY, 0, 0, 'WITHSCORES')
  const oldestSeq = oldest.length >= 2 ? Number(oldest[1]) : null
  if (oldestSeq == null) {
    const current = Number((await redis.get(SEQ_KEY)) ?? 0)
    return { oldestSeq, current, entries: [] }
  }
  if (cursor + 1 < oldestSeq) return { oldestSeq, current: 0, entries: [] }
  const raw = await redis.zrangebyscore(
    JOURNAL_KEY,
    `(${cursor}`,
    '+inf',
    'LIMIT',
    0,
    REPLAY_CAP * 4 + REPLAY_BUCKET
  )
  const entries: JournalEntry[] = []
  for (const r of raw) {
    try {
      entries.push(JSON.parse(r) as JournalEntry)
    } catch {
      // skip corrupt entry
    }
  }
  return { oldestSeq, current: 0, entries }
}

function sharedJournalWindow(redis: Redis, cursor: number): Promise<JournalWindow> {
  const wait = replayBatchMs()
  if (wait <= 0) return readJournalWindow(redis, cursor)
  let byKey = pendingReads.get(redis)
  if (!byKey) {
    byKey = new Map()
    pendingReads.set(redis, byKey)
  }
  const key = `${currentTenantKey()}\u0000${Math.floor(cursor / REPLAY_BUCKET)}`
  const waiting = byKey.get(key)
  if (waiting) {
    replayStats.shared++
    if (cursor < waiting.minCursor) waiting.minCursor = cursor
    return waiting.promise
  }
  const map = byKey
  const entry: PendingRead = { minCursor: cursor, promise: Promise.resolve(null as never) }
  entry.promise = new Promise<JournalWindow>((resolve, reject) => {
    const t = setTimeout(() => {
      // From here on nobody joins this read: a later caller starts its own.
      if (map.get(key) === entry) map.delete(key)
      readJournalWindow(redis, entry.minCursor).then(resolve, reject)
    }, wait)
    ;(t as { unref?: () => void }).unref?.()
  })
  map.set(key, entry)
  return entry.promise
}

async function replayFromRedis(
  cursor: number,
  rooms: Set<string>
): Promise<{ full: boolean; events: JournalEntry[] }> {
  if (!_redis) return { full: true, events: [] }
  try {
    const w = await sharedJournalWindow(_redis, cursor)
    // If the oldest retained seq is beyond the cursor+1, we lost events.
    if (w.oldestSeq != null && cursor + 1 < w.oldestSeq) return { full: true, events: [] }
    if (w.oldestSeq == null) {
      // The journal key expired after a quiet spell. Anything after the cursor
      // happened more than JOURNAL_TTL ago — not "nothing happened".
      return w.current > cursor ? { full: true, events: [] } : { full: false, events: [] }
    }
    const events: JournalEntry[] = []
    for (const e of w.entries) {
      if (!(e.seq > cursor) || !rooms.has(e.room)) continue
      events.push(e)
      // More than one replay carries — reload rather than replay a part.
      if (events.length > REPLAY_CAP) return { full: true, events: [] }
    }
    return { full: false, events }
  } catch {
    return { full: true, events: [] }
  }
}

/** Durable-table replays at once per process (REALTIME_TABLE_REPLAY_CONCURRENCY, default 4). */
function tableReplayLimit(): number {
  const n = Number(process.env.REALTIME_TABLE_REPLAY_CONCURRENCY)
  return Number.isFinite(n) && n >= 1 ? Math.min(64, Math.floor(n)) : 4
}
let tableActive = 0
const tableQueue: Array<() => void> = []

async function withTableSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (tableActive >= tableReplayLimit())
    await new Promise<void>((resolve) => tableQueue.push(resolve))
  tableActive++
  try {
    return await fn()
  } finally {
    tableActive--
    tableQueue.shift()?.()
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
