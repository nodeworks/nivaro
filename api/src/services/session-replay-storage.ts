/**
 * Session replay storage tiering (#1411).
 *
 * A recording is watched most in its first days. After
 * nivaro_settings.replay_cold_after_days (default 3) its chunks leave the
 * database: they are written as ONE gzipped object per recording to the
 * configured storage driver (local disk, S3 or Azure Blob — the same driver
 * file uploads use, services/storage-drivers.ts), the header row is marked
 * cold with the object's key and size, and the event rows are deleted.
 *
 * Opening a cold recording rehydrates it: GET /:id/events answers 202
 * ("loading from storage") while one replica downloads the object and puts
 * the chunks back in nivaro_session_events, then serves them as usual. The
 * reloaded rows are a 24-hour hot cache — the hourly tiering job deletes them
 * again (the object stays). Purging or deleting a recording deletes its
 * object too.
 *
 * Object format: gzip of newline-separated `<seq>\t<events JSON>` lines after
 * a `#nivaro-replay v1 <id>` header. JSON.stringify output never contains a
 * raw newline or tab, so lines split without parsing the (large) events.
 */
import { gunzipSync, gzipSync } from 'node:zlib'
import { db } from '../db/index.js'

export const DEFAULT_COLD_AFTER_DAYS = 3
/** How long a rehydrated recording's chunks stay in the table. */
export const HOT_CACHE_MS = 24 * 60 * 60_000
/** A claimed reload that hasn't finished by then is taken over. */
export const REHYDRATE_STALE_MS = 5 * 60_000
/** Recordings still receiving events are left alone this long after the last one. */
const QUIET_BEFORE_COLD_MS = 60 * 60_000
const INSERT_BATCH = 25
const HEADER = '#nivaro-replay v1'

/** Where the objects go — swappable for tests. */
export interface ReplayObjectStore {
  put(key: string, body: Buffer, mime: string): Promise<void>
  get(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
}

// Loaded on first use: the storage layer reads the process config, which
// the recordings routes (and their tests) have no reason to pull in.
const drivers = () => import('./storage-drivers.js')
const driverStore: ReplayObjectStore = {
  put: async (key, body, mime) =>
    (await (await drivers()).getActiveStorageDriver()).put(key, body, mime),
  get: async (key) => (await drivers()).readStoredObject(key),
  delete: async (key) => (await drivers()).deleteStoredObject(key)
}
let objectStore: ReplayObjectStore = driverStore

export function setReplayObjectStore(store: ReplayObjectStore | null): void {
  objectStore = store ?? driverStore
}

// ── Settings ─────────────────────────────────────────────────────────────────

export function validateColdAfterDays(raw: unknown): { value: number | null } | { error: string } {
  if (raw == null || raw === '') return { value: null }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 365) {
    return { error: 'replay_cold_after_days must be a whole number of days from 1 to 365' }
  }
  return { value: n }
}

export async function coldAfterDays(): Promise<number> {
  try {
    const row = (await db('nivaro_settings').where({ id: 1 }).first('replay_cold_after_days')) as
      | { replay_cold_after_days?: unknown }
      | undefined
    const n = Number(row?.replay_cold_after_days)
    if (!Number.isFinite(n) || n < 1) return DEFAULT_COLD_AFTER_DAYS
    return Math.min(Math.trunc(n), 365)
  } catch {
    return DEFAULT_COLD_AFTER_DAYS
  }
}

// ── Chunk codec (same storage shape as routes/session-recordings.ts) ─────────

function encodeChunk(json: string): string {
  return `gz:${gzipSync(Buffer.from(json, 'utf8')).toString('base64')}`
}

function decodeChunk(stored: string): string {
  if (stored.startsWith('gz:')) {
    return gunzipSync(Buffer.from(stored.slice(3), 'base64')).toString('utf8')
  }
  return stored
}

/** One object for a recording's chunks. */
export function packReplayChunks(
  recordingId: string,
  chunks: Array<{ seq: number; events: string }>
): Buffer {
  const parts: Buffer[] = [Buffer.from(`${HEADER} ${recordingId}\n`, 'utf8')]
  for (const c of chunks) {
    let json: string
    try {
      json = decodeChunk(c.events)
    } catch {
      continue // a corrupt chunk was unreadable hot too
    }
    // Guard the line format: stored chunks come from JSON.stringify, which
    // escapes newlines — anything else is not ours to carry.
    if (json.includes('\n')) json = JSON.stringify(JSON.parse(json))
    parts.push(Buffer.from(`${Math.trunc(c.seq)}\t${json}\n`, 'utf8'))
  }
  return gzipSync(Buffer.concat(parts))
}

export function unpackReplayChunks(body: Buffer): Array<{ seq: number; json: string }> {
  const text = gunzipSync(body).toString('utf8')
  const out: Array<{ seq: number; json: string }> = []
  let first = true
  for (const line of text.split('\n')) {
    if (first) {
      first = false
      if (!line.startsWith(HEADER)) throw new Error('Not a session replay object')
      continue
    }
    if (!line) continue
    const tab = line.indexOf('\t')
    const seq = Number(line.slice(0, tab))
    if (tab < 1 || !Number.isInteger(seq)) continue
    out.push({ seq, json: line.slice(tab + 1) })
  }
  return out
}

export function coldKeyFor(recordingId: string, startedAt: Date | string | null): string {
  const d = startedAt ? new Date(startedAt) : new Date()
  const y = Number.isNaN(d.getTime()) ? 'unknown' : String(d.getUTCFullYear())
  const m = Number.isNaN(d.getTime()) ? '00' : String(d.getUTCMonth() + 1).padStart(2, '0')
  return `session-replays/${y}/${m}/${recordingId}.ndjson.gz`
}

// ── Hot → cold ───────────────────────────────────────────────────────────────

/**
 * Move one recording's chunks to the storage driver. The object is written
 * first; only then is the row marked cold and are the event rows deleted —
 * a failed upload leaves the recording hot and untouched.
 */
export async function moveRecordingCold(
  recordingId: string,
  now: Date = new Date()
): Promise<{ moved: boolean; bytes: number }> {
  const rec = (await db('nivaro_session_recordings')
    .where({ id: recordingId })
    .first('id', 'started_at', 'cold')) as
    | { id: string; started_at: Date | string | null; cold?: unknown }
    | undefined
  if (!rec || rec.cold === true || rec.cold === 1) return { moved: false, bytes: 0 }
  const chunks = (await db('nivaro_session_events')
    .where({ recording: recordingId })
    .orderBy('seq', 'asc')
    .select('seq', 'events')) as Array<{ seq: number; events: string }>
  let key: string | null = null
  let bytes = 0
  if (chunks.length > 0) {
    const body = packReplayChunks(recordingId, chunks)
    key = coldKeyFor(recordingId, rec.started_at)
    await objectStore.put(key, body, 'application/gzip')
    bytes = body.length
  }
  const updated = await db('nivaro_session_recordings')
    .where({ id: recordingId, cold: false })
    .update({ cold: true, cold_key: key, cold_bytes: bytes, cold_at: now, rehydrated_at: null })
  if (!Number(updated)) {
    // Someone else moved it in the meantime; theirs is the object of record.
    if (key) await objectStore.delete(key).catch(() => {})
    return { moved: false, bytes: 0 }
  }
  await db('nivaro_session_events').where({ recording: recordingId }).del()
  return { moved: true, bytes }
}

/** Drop the hot cache of recordings rehydrated more than HOT_CACHE_MS ago. */
export async function evictHotCaches(now: Date = new Date()): Promise<number> {
  const before = new Date(now.getTime() - HOT_CACHE_MS)
  const ids = (await db('nivaro_session_recordings')
    .where({ cold: true })
    .where('rehydrated_at', '<', before)
    .limit(500)
    .pluck('id')) as string[]
  for (const id of ids) {
    await db('nivaro_session_events').where({ recording: id }).del()
    await db('nivaro_session_recordings')
      .where({ id })
      .update({ rehydrated_at: null, rehydrate_started_at: null })
  }
  return ids.length
}

export interface TieringSummary {
  moved: number
  bytes: number
  evicted: number
  failed: number
  summary: string
}

/**
 * The hourly tiering pass: evict expired hot caches, then move recordings
 * past replay_cold_after_days (oldest first, `limit` per pass, within
 * `budgetMs`). A recording that fails stays hot and is retried next pass.
 */
export async function runReplayTiering(
  opts: { now?: Date; limit?: number; budgetMs?: number } = {}
): Promise<TieringSummary> {
  const now = opts.now ?? new Date()
  const started = Date.now()
  const budget = opts.budgetMs ?? 10 * 60_000
  const evicted = await evictHotCaches(now)
  const days = await coldAfterDays()
  const cutoff = new Date(now.getTime() - days * 86_400_000)
  const quiet = new Date(now.getTime() - QUIET_BEFORE_COLD_MS)
  const ids = (await db('nivaro_session_recordings')
    .where({ cold: false })
    .where('started_at', '<', cutoff)
    .where((q) => q.whereNotNull('ended_at').orWhere('last_event_at', '<', quiet))
    .orderBy('started_at', 'asc')
    .limit(opts.limit ?? 200)
    .pluck('id')) as string[]
  let moved = 0
  let bytes = 0
  let failed = 0
  for (const id of ids) {
    if (Date.now() - started > budget) break
    try {
      const r = await moveRecordingCold(id, now)
      if (r.moved) {
        moved++
        bytes += r.bytes
      }
    } catch {
      failed++
    }
  }
  const summary = `${moved} recording(s) moved to storage (${Math.round(bytes / 1024)} KB), ${evicted} hot cache(s) dropped${failed ? `, ${failed} failed` : ''}`
  return { moved, bytes, evicted, failed, summary }
}

// ── Cold → hot (rehydrate) ───────────────────────────────────────────────────

const inflight = new Map<string, Promise<void>>()
const failures = new Map<string, { at: number; message: string }>()

/** Tests start from a clean slate. */
export function resetReplayStorageState(): void {
  inflight.clear()
  failures.clear()
}

async function rehydrate(recordingId: string, key: string): Promise<void> {
  try {
    const chunks = unpackReplayChunks(await objectStore.get(key))
    await db('nivaro_session_events').where({ recording: recordingId }).del()
    const now = new Date()
    for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
      await db('nivaro_session_events').insert(
        chunks.slice(i, i + INSERT_BATCH).map((c) => ({
          recording: recordingId,
          seq: c.seq,
          events: encodeChunk(c.json),
          created_at: now
        }))
      )
    }
    await db('nivaro_session_recordings')
      .where({ id: recordingId })
      .update({ rehydrated_at: new Date(), rehydrate_started_at: null })
    failures.delete(recordingId)
  } catch (err) {
    failures.set(recordingId, {
      at: Date.now(),
      message: err instanceof Error ? err.message : String(err)
    })
    await db('nivaro_session_recordings')
      .where({ id: recordingId })
      .update({ rehydrate_started_at: null })
      .catch(() => {})
    throw err
  }
}

export type HotState =
  | { state: 'hot' }
  | { state: 'loading' }
  | { state: 'missing' }
  | { state: 'failed'; message: string }

/**
 * Make a recording's chunks readable from nivaro_session_events. A hot
 * recording (or a warm cache) answers at once; a cold one starts — or joins —
 * a reload and answers 'loading', or with `wait` resolves once it is back.
 */
export async function ensureRecordingHot(
  recordingId: string,
  opts: { wait?: boolean; now?: Date } = {}
): Promise<HotState> {
  const now = opts.now ?? new Date()
  let rec:
    | {
        cold?: unknown
        cold_key?: string | null
        rehydrated_at?: Date | string | null
        rehydrate_started_at?: Date | string | null
      }
    | undefined
  try {
    rec = await db('nivaro_session_recordings')
      .where({ id: recordingId })
      .first('id', 'cold', 'cold_key', 'rehydrated_at', 'rehydrate_started_at')
  } catch {
    return { state: 'hot' } // pre-migration: everything is hot
  }
  if (!rec) return { state: 'missing' }
  if (!(rec.cold === true || rec.cold === 1)) return { state: 'hot' }
  if (!rec.cold_key) return { state: 'hot' } // moved with no chunks: nothing to load
  if (rec.rehydrated_at && now.getTime() - new Date(rec.rehydrated_at).getTime() < HOT_CACHE_MS) {
    return { state: 'hot' }
  }
  const failed = failures.get(recordingId)
  if (failed && Date.now() - failed.at < 30_000 && !inflight.has(recordingId)) {
    return { state: 'failed', message: failed.message }
  }

  let job = inflight.get(recordingId)
  if (!job) {
    // Claim the reload across replicas: whoever stamps rehydrate_started_at
    // does it; the others answer 'loading' until rehydrated_at appears.
    const staleBefore = new Date(now.getTime() - REHYDRATE_STALE_MS)
    const claimed = await db('nivaro_session_recordings')
      .where({ id: recordingId })
      .where((q) =>
        q.whereNull('rehydrate_started_at').orWhere('rehydrate_started_at', '<', staleBefore)
      )
      .update({ rehydrate_started_at: now })
    if (!Number(claimed)) {
      if (!opts.wait) return { state: 'loading' }
      return waitForOtherReplica(recordingId)
    }
    const key = rec.cold_key
    job = rehydrate(recordingId, key).finally(() => inflight.delete(recordingId))
    inflight.set(recordingId, job)
    job.catch(() => {})
  }
  if (!opts.wait) return { state: 'loading' }
  try {
    await job
    return { state: 'hot' }
  } catch (err) {
    return { state: 'failed', message: err instanceof Error ? err.message : String(err) }
  }
}

async function waitForOtherReplica(recordingId: string): Promise<HotState> {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const rec = (await db('nivaro_session_recordings')
      .where({ id: recordingId })
      .first('rehydrated_at')) as { rehydrated_at?: unknown } | undefined
    if (rec?.rehydrated_at) return { state: 'hot' }
  }
  return { state: 'loading' }
}

// ── Purge ────────────────────────────────────────────────────────────────────

/** Delete the cold object of one recording (before its row goes). */
export async function deleteColdObject(recordingId: string): Promise<void> {
  try {
    const rec = (await db('nivaro_session_recordings')
      .where({ id: recordingId })
      .first('cold_key')) as { cold_key?: string | null } | undefined
    if (rec?.cold_key) await objectStore.delete(rec.cold_key)
  } catch {
    /* pre-migration or storage unreachable — the row still goes */
  }
}

/** Delete the cold objects of every recording the retention purge is about to drop. */
export async function purgeColdObjects(cutoff: Date): Promise<number> {
  let keys: string[] = []
  try {
    keys = (await db('nivaro_session_recordings')
      .where('started_at', '<', cutoff)
      .whereNotNull('cold_key')
      .pluck('cold_key')) as string[]
  } catch {
    return 0
  }
  let n = 0
  for (const key of keys) {
    try {
      await objectStore.delete(key)
      n++
    } catch {
      /* best-effort: an unreachable store must not block the retention purge */
    }
  }
  return n
}

// ── Sizes (DB Health, the storage snapshot) ──────────────────────────────────

export interface ReplayTierSizes {
  recordings: number
  /** Chunk bytes in the database for recordings that are not cold. */
  hot_bytes: number
  cold_recordings: number
  /** Object bytes in the storage driver. */
  cold_bytes: number
  /** Chunk bytes of cold recordings currently rehydrated (24-hour cache). */
  cache_bytes: number
}

export async function replayTierSizes(): Promise<ReplayTierSizes> {
  const row = (await db('nivaro_session_recordings')
    .select(
      db.raw('COUNT(*) AS n'),
      db.raw('SUM(CASE WHEN cold = ? THEN 0 ELSE CAST(byte_size AS BIGINT) END) AS hot', [true]),
      db.raw('SUM(CASE WHEN cold = ? THEN 1 ELSE 0 END) AS cold_n', [true]),
      db.raw('SUM(CASE WHEN cold = ? THEN COALESCE(cold_bytes, 0) ELSE 0 END) AS cold_b', [true]),
      db.raw(
        'SUM(CASE WHEN cold = ? AND rehydrated_at IS NOT NULL THEN CAST(byte_size AS BIGINT) ELSE 0 END) AS cache',
        [true]
      )
    )
    .first()) as Record<string, unknown> | undefined
  return {
    recordings: Number(row?.n) || 0,
    hot_bytes: Number(row?.hot) || 0,
    cold_recordings: Number(row?.cold_n) || 0,
    cold_bytes: Number(row?.cold_b) || 0,
    cache_bytes: Number(row?.cache) || 0
  }
}
