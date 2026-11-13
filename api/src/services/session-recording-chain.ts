/**
 * Recording parts (2026-11-09): a session longer than one recording's size cap
 * keeps recording, with nothing lost and nothing visible to anyone.
 *
 * A recording stops taking chunks once it holds MAX_BYTES (stored). Before,
 * the chunk route then marked it truncated and answered 409, the recorder
 * stopped for good, and the rest of that visit was never recorded (on dev,
 * 120 of 7,598 recordings ended that way, after 20 minutes to 31 hours).
 *
 * Now the chunk route rolls the recording over instead: it ends the full part,
 * starts the next part as a new nivaro_session_recordings row, and stores the
 * chunk there. The recorder is never told — it keeps posting to the id it
 * knows, with its own seq, and the route follows the chain to the newest part.
 * So the recorders (admin, @nivaro/react in every host) need no change.
 *
 * Each part opens with a copy of the previous part's last Meta + full snapshot
 * and every event after it, stored at seq -1, so a part can also be read on
 * its own (a chain whose first part has been purged). Read as a chain, those
 * copies are skipped: the chain plays as one recording, one timeline.
 *
 * The link lives in the existing `meta` JSON, written only by the server (the
 * start route's allowlist drops these keys from a client):
 *  - every later part: `chain` (the first part's id), `continues` (the part
 *    before it), `part` (2, 3, …);
 *  - the first part: `parts` (how many parts the chain has, once it has more
 *    than one).
 * The list shows first parts only, with the chain's totals; any part's id
 * opens the whole chain.
 */
import { randomUUID } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import { parsedChunks } from './session-replay-chunks.js'
import { ensureRecordingHot, type HotState } from './session-replay-storage.js'

const RECORDINGS = 'nivaro_session_recordings'
const EVENTS = 'nivaro_session_events'

/** Seq of the copied opening a later part carries; never a recorder seq. */
export const CARRIED_SEQ = -1

/** Apps whose recordings never roll over: one-shot clips are cut, not streamed. */
const ONE_SHOT_APPS = new Set(['error-clip', 'support-clip', 'clip'])

const FULL_SNAPSHOT = 2
const META = 4

export interface ChainMeta {
  chain?: string
  continues?: string
  part?: number
  parts?: number
}

export interface PartRow {
  id: string
  user: string
  app: string | null
  origin?: string | null
  meta: string | null
  masquerade_admin?: string | null
  started_at: Date | string | null
  ended_at: Date | string | null
  last_event_at: Date | string | null
  event_count: number | null
  byte_size: number | null
  truncated: boolean | number | null
  active_ms?: number | null
  chapter_count?: number | null
}

const PART_COLUMNS = [
  'id',
  'user',
  'app',
  'origin',
  'meta',
  'masquerade_admin',
  'started_at',
  'ended_at',
  'last_event_at',
  'event_count',
  'byte_size',
  'truncated'
] as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── Pure ────────────────────────────────────────────────────────────────────

export function parseRecordingMeta(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function chainMetaOf(raw: unknown): ChainMeta {
  const m = parseRecordingMeta(raw)
  const out: ChainMeta = {}
  if (typeof m.chain === 'string' && UUID.test(m.chain)) out.chain = m.chain
  if (typeof m.continues === 'string' && UUID.test(m.continues)) out.continues = m.continues
  if (Number.isInteger(m.part) && (m.part as number) > 1) out.part = m.part as number
  if (Number.isInteger(m.parts) && (m.parts as number) > 1) out.parts = m.parts as number
  return out
}

/** A later part (never listed on its own). */
export function isContinuationPart(raw: unknown): boolean {
  return !!chainMetaOf(raw).chain
}

/** The chain keys removed — for a copy that is not part of the chain (a clip). */
export function stripChainKeys(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const m = parseRecordingMeta(raw)
  if (!('chain' in m || 'continues' in m || 'part' in m || 'parts' in m)) return raw
  const { chain: _c, continues: _n, part: _p, parts: _s, ...rest } = m
  return Object.keys(rest).length ? JSON.stringify(rest) : null
}

/** One recording never rolls over when it is a one-shot clip. */
export function rollsOver(app: string | null | undefined): boolean {
  return !ONE_SHOT_APPS.has(String(app ?? ''))
}

export type RrwebEventLike = { type?: unknown; timestamp?: unknown }

/**
 * What a new part opens with: the last full snapshot of the part before it,
 * the Meta event before that snapshot (it carries the viewport), and every
 * event after the snapshot. Empty when there is no snapshot.
 */
export function carriedOpening<T extends RrwebEventLike>(events: T[]): T[] {
  let snap = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === FULL_SNAPSHOT) {
      snap = i
      break
    }
  }
  if (snap < 0) return []
  let meta = -1
  for (let i = snap - 1; i >= 0; i--) {
    if (events[i]?.type === META) {
      meta = i
      break
    }
  }
  return [...(meta >= 0 ? [events[meta]] : []), ...events.slice(snap)]
}

const ms = (v: Date | string | null | undefined): number | null => {
  if (v == null) return null
  const t = new Date(v).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * The chain's figures, as the list and the header show one recording: start
 * of the first part, end and last activity of the last, sums of the rest.
 */
export function chainSummary(parts: PartRow[]): Partial<PartRow> & { parts: number } {
  if (parts.length === 0) return { parts: 0 }
  const first = parts[0]
  const last = parts[parts.length - 1]
  const sum = (k: 'event_count' | 'byte_size' | 'active_ms' | 'chapter_count') =>
    parts.reduce((n, p) => n + (Number(p[k]) || 0), 0)
  const lastActivity = parts.reduce<number | null>((m, p) => {
    const t = ms(p.last_event_at)
    return t != null && (m == null || t > m) ? t : m
  }, null)
  return {
    started_at: first.started_at,
    ended_at: last.ended_at,
    last_event_at: lastActivity != null ? new Date(lastActivity) : last.last_event_at,
    event_count: sum('event_count'),
    byte_size: sum('byte_size'),
    truncated: last.truncated,
    ...(parts.some((p) => p.active_ms != null) ? { active_ms: sum('active_ms') } : {}),
    ...(parts.some((p) => p.chapter_count != null) ? { chapter_count: sum('chapter_count') } : {}),
    parts: parts.length
  }
}

/**
 * Which stored chunks a chain reads as one stream, in order: every part's own
 * chunks; a part's copied opening (seq -1) only when it is the first part
 * read (its predecessor is gone, or it is read from `afterSeq` on, never).
 */
export function chainReadOrder<C extends { recording: string; seq: number }>(
  partIds: string[],
  chunks: C[],
  opts: { afterSeq?: number } = {}
): C[] {
  const rank = new Map(partIds.map((id, i) => [id, i]))
  const incremental = typeof opts.afterSeq === 'number' && Number.isFinite(opts.afterSeq)
  return chunks
    .filter((c) => rank.has(c.recording))
    .filter((c) => {
      if (c.seq >= 0) return !incremental || c.seq > (opts.afterSeq as number)
      return !incremental && rank.get(c.recording) === 0
    })
    .sort((a, b) => (rank.get(a.recording) ?? 0) - (rank.get(b.recording) ?? 0) || a.seq - b.seq)
}

// ── Stored chunks ───────────────────────────────────────────────────────────

function encode(json: string): string {
  return `gz:${gzipSync(Buffer.from(json, 'utf8')).toString('base64')}`
}

function decode(stored: string): string {
  if (stored.startsWith('gz:'))
    return gunzipSync(Buffer.from(stored.slice(3), 'base64')).toString('utf8')
  return stored
}

// ── Database ────────────────────────────────────────────────────────────────

/**
 * Every part of the chain `anyId` belongs to, first part first. A recording
 * that never rolled over answers itself alone (one indexed read). Empty when
 * the id is unknown. On a read error, the recording alone.
 */
export async function chainParts(anyId: string): Promise<PartRow[]> {
  let row: PartRow | undefined
  try {
    row = (await db(RECORDINGS)
      .where({ id: anyId })
      .first(...PART_COLUMNS)) as PartRow | undefined
  } catch {
    return [{ id: anyId } as PartRow]
  }
  if (!row) return []
  const own = chainMetaOf(row.meta)
  if (!own.chain && !own.parts) return [row]
  const head = own.chain ?? row.id
  try {
    const later = (await db(RECORDINGS)
      .where('user', row.user)
      .andWhere('meta', 'like', `%"chain":"${head}"%`)
      .select(...PART_COLUMNS)) as PartRow[]
    const first =
      head === row.id
        ? row
        : ((await db(RECORDINGS)
            .where({ id: head })
            .first(...PART_COLUMNS)) as PartRow | undefined)
    const parts = [...(first ? [first] : []), ...later.filter((p) => p.id !== first?.id)]
    return parts.sort((a, b) => (chainMetaOf(a.meta).part ?? 1) - (chainMetaOf(b.meta).part ?? 1))
  } catch {
    return [row]
  }
}

/** The part a recorder's chunk belongs in now: the chain's newest part. */
export async function newestPart(anyId: string): Promise<PartRow | null> {
  const parts = await chainParts(anyId)
  return parts.length ? parts[parts.length - 1] : null
}

/**
 * Has any part of these got this seq already? A recorder retries a chunk
 * under the same seq; after a roll-over the first copy may sit in an earlier
 * part.
 */
export async function chainHasSeq(partIds: string[], seq: number): Promise<boolean> {
  const row = await db(EVENTS).whereIn('recording', partIds).where('seq', seq).first('id')
  return !!row
}

/** The worst storage state among the parts (#1411): loading or failed wins. */
export async function ensureChainHot(
  parts: Array<{ id: string }>,
  opts: { wait?: boolean } = {}
): Promise<HotState> {
  let worst: HotState = { state: 'hot' }
  for (const p of parts) {
    const s = await ensureRecordingHot(p.id, opts)
    if (s.state === 'failed') return s
    if (s.state === 'loading') worst = s
  }
  return worst
}

/** The chain's stored chunks as one stream (see chainReadOrder). */
export async function chainChunks(
  parts: Array<{ id: string }>,
  opts: { afterSeq?: number } = {}
): Promise<Array<{ recording: string; seq: number; events: string }>> {
  const ids = parts.map((p) => p.id)
  if (ids.length === 0) return []
  const incremental = typeof opts.afterSeq === 'number' && Number.isFinite(opts.afterSeq)
  const rows = (await db(EVENTS)
    .whereIn('recording', ids)
    .modify((qb) => {
      if (incremental) qb.where('seq', '>', opts.afterSeq as number)
    })
    .select('recording', 'seq', 'events')) as Array<{
    recording: string
    seq: number
    events: string
  }>
  return chainReadOrder(ids, rows, opts)
}

// ── Reading a recording a batch at a time (the events answer) ───────────────

/** One stored chunk a read will cover: where it is and about how big, never its text. */
export interface ChunkRef {
  recording: string
  seq: number
  /** Stored size in characters (0 when the database did not say). */
  size: number
}

/** Chunks of one recording read together: every row from `fromSeq` to `toSeq`. */
export interface ChunkBatch {
  recording: string
  fromSeq: number
  toSeq: number
  /** How many rows the plan saw in that range. */
  rows: number
}

/** About 1M stored characters a batch: a few MB in memory, ~15 round trips for a full part. */
export const CHUNK_BATCH_CHARS = 1_000_000
export const CHUNK_BATCH_ROWS = 200

/**
 * The chunks a read covers, in read order, without their text: which rows and how big each
 * is. One recording reads its own chunks in seq order (its copied opening included: it is
 * read alone); a chain reads as chainReadOrder says. `afterSeq` is live follow.
 */
export async function chunkPlan(
  partIds: string[],
  opts: { afterSeq?: number } = {}
): Promise<ChunkRef[]> {
  if (partIds.length === 0) return []
  const incremental = typeof opts.afterSeq === 'number' && Number.isFinite(opts.afterSeq)
  const single = partIds.length === 1
  // The size comes from the row's own length field: the chunk text is not read for it.
  const size = db.raw(isMssql(db) ? 'DATALENGTH(events) / 2 AS size' : 'LENGTH(events) AS size')
  const rows = (await db(EVENTS)
    .modify((qb) => {
      if (single) qb.where({ recording: partIds[0] })
      else qb.whereIn('recording', partIds)
      if (incremental) qb.where('seq', '>', opts.afterSeq as number)
    })
    .orderBy('seq', 'asc')
    .select('recording', 'seq', size)) as Array<{
    recording?: string
    seq: number
    size?: number | string | null
  }>
  const refs = rows.map((r) => ({
    // One recording is named as the caller named it: the database compares ids without
    // regard to letter case, a JavaScript Map does not.
    recording: single ? partIds[0] : String(r.recording),
    seq: Number(r.seq),
    size: Number(r.size) || 0
  }))
  return single ? refs : chainReadOrder(partIds, refs, opts)
}

/**
 * The plan cut into batches: runs of one recording's chunks, in order, of at most
 * `maxChars` stored characters (a single bigger chunk is a batch of its own) and `maxRows`
 * rows. Two rows with the same seq are never split: a batch is read as a seq range.
 */
export function planBatches(
  plan: ChunkRef[],
  opts: { maxChars?: number; maxRows?: number } = {}
): ChunkBatch[] {
  const maxChars = opts.maxChars ?? CHUNK_BATCH_CHARS
  const maxRows = opts.maxRows ?? CHUNK_BATCH_ROWS
  const out: ChunkBatch[] = []
  let cur: ChunkBatch | null = null
  let chars = 0
  for (const ref of plan) {
    const fits =
      cur !== null &&
      cur.recording === ref.recording &&
      ref.seq >= cur.toSeq &&
      (ref.seq === cur.toSeq || (chars + ref.size <= maxChars && cur.rows < maxRows))
    if (cur !== null && fits) {
      cur.toSeq = ref.seq
      cur.rows++
    } else {
      cur = { recording: ref.recording, fromSeq: ref.seq, toSeq: ref.seq, rows: 1 }
      out.push(cur)
      chars = 0
    }
    chars += ref.size
  }
  return out
}

/**
 * The planned chunks' text, in plan order, one batch in memory at a time. The next batch is
 * read only when the caller asks for its first row, and no connection is held in between —
 * so a response that waits on a slow reader holds nothing, and one that ends stops the read.
 *
 * The read is no longer one statement, so the recording can change under it: chunks go when
 * a recording is deleted, purged, or its hot cache is dropped (hourly, for a recording kept
 * in storage). A batch that comes back with fewer rows than the plan saw fails the read
 * (409 before the answer started, a cut-short answer after) — the caller opens it again and
 * gets the whole recording, never a quietly shorter replay. More rows than planned is a
 * live recording still being written, and fine.
 */
export async function* readPlannedChunks(
  plan: ChunkRef[],
  opts: { maxChars?: number; maxRows?: number } = {}
): AsyncGenerator<{ recording: string; seq: number; events: string }> {
  for (const batch of planBatches(plan, opts)) {
    const rows = (await db(EVENTS)
      .where({ recording: batch.recording })
      .where('seq', '>=', batch.fromSeq)
      .where('seq', '<=', batch.toSeq)
      .orderBy('seq', 'asc')
      .select('seq', 'events')) as Array<{ seq: number; events: string }>
    if (rows.length < batch.rows) {
      throw Object.assign(new Error('This recording changed while it was being read'), {
        statusCode: 409,
        code: 'RECORDING_CHANGED'
      })
    }
    for (const row of rows) {
      yield { recording: batch.recording, seq: Number(row.seq), events: row.events }
    }
  }
}

/** Every event of the chain `anyId` belongs to, in order (a corrupt chunk is skipped). */
export async function loadChainEvents<T = unknown>(anyId: string): Promise<T[]> {
  const parts = await chainParts(anyId)
  await ensureChainHot(parts, { wait: true }).catch(() => null)
  const chunks = await chainChunks(parts)
  const out: T[] = []
  // One chunk at a time, the event loop free in between (./session-replay-chunks).
  for await (const parsed of parsedChunks(chunks)) {
    if (!Array.isArray(parsed)) continue
    for (const e of parsed) out.push(e as T)
  }
  return out
}

/** Read a part's copied opening from its newest chunks back to the last full snapshot. */
async function openingFor(partId: string, maxRawBytes: number): Promise<RrwebEventLike[]> {
  const seqs = (await db(EVENTS)
    .where({ recording: partId })
    .where('seq', '>=', CARRIED_SEQ)
    .orderBy('seq', 'desc')
    .select('seq')) as Array<{ seq: number }>
  const collected: RrwebEventLike[][] = []
  for (const { seq } of seqs) {
    const row = (await db(EVENTS).where({ recording: partId, seq }).first('events')) as
      | { events: string }
      | undefined
    if (!row) continue
    let events: RrwebEventLike[]
    try {
      events = JSON.parse(decode(row.events)) as RrwebEventLike[]
    } catch {
      continue
    }
    if (!Array.isArray(events)) continue
    collected.unshift(events)
    if (events.some((e) => e?.type === FULL_SNAPSHOT)) break
  }
  const opening = carriedOpening(collected.flat())
  if (opening.length === 0) return []
  if (JSON.stringify(opening).length <= maxRawBytes) return opening
  // Too much happened since the last snapshot: keep the page as it was then.
  const snapAt = opening.findIndex((e) => e?.type === FULL_SNAPSHOT)
  const short = opening.slice(0, snapAt + 1)
  return JSON.stringify(short).length <= maxRawBytes ? short : []
}

/**
 * End `part` and start the chain's next part, opened with a copy of its last
 * snapshot and what followed. Null when another request ended `part` first.
 * The caller stores the chunk that did not fit into the part returned.
 */
export async function rollOver(
  part: PartRow,
  opts: { maxRawBytes: number; now?: Date }
): Promise<{ id: string; byte_size: number } | null> {
  const now = opts.now ?? new Date()
  const claimed = await db(RECORDINGS)
    .where({ id: part.id })
    .whereNull('ended_at')
    .update({ ended_at: now })
  if (!claimed) return null

  const own = chainMetaOf(part.meta)
  const head = own.chain ?? part.id
  const partNo = (own.part ?? 1) + 1
  const base = parseRecordingMeta(part.meta)
  const { parts: _parts, ...kept } = base
  const meta = JSON.stringify({ ...kept, chain: head, continues: part.id, part: partNo })

  let opening: RrwebEventLike[] = []
  try {
    opening = await openingFor(part.id, opts.maxRawBytes)
  } catch {
    opening = []
  }
  const stored = opening.length ? encode(JSON.stringify(opening)) : null
  const id = randomUUID()
  try {
    await createNextPart()
  } catch (err) {
    // No next part: reopen this one, so the caller can answer as before.
    await db(RECORDINGS)
      .where({ id: part.id })
      .update({ ended_at: null })
      .catch(() => {})
    throw err
  }
  return { id, byte_size: stored ? stored.length : 0 }

  async function createNextPart() {
    await db.transaction(async (trx) => {
      await trx(RECORDINGS).insert({
        id,
        user: part.user,
        app: part.app ?? null,
        origin: part.origin ?? null,
        meta,
        masquerade_admin: part.masquerade_admin ?? null,
        started_at: now,
        last_event_at: now,
        event_count: opening.length,
        byte_size: stored ? stored.length : 0
      })
      if (stored) {
        await trx(EVENTS).insert({
          recording: id,
          seq: CARRIED_SEQ,
          events: stored,
          created_at: now
        })
      }
      // The first part counts the chain's parts, so its readers know to look.
      const headRow = (await trx(RECORDINGS).where({ id: head }).first('meta')) as
        | { meta: string | null }
        | undefined
      if (headRow) {
        await trx(RECORDINGS)
          .where({ id: head })
          .update({ meta: JSON.stringify({ ...parseRecordingMeta(headRow.meta), parts: partNo }) })
      }
    })
  }
}

/** End every open part of the chain (the recorder's end call names the first). */
export async function endChain(anyId: string, now: Date = new Date()): Promise<void> {
  const parts = await chainParts(anyId)
  const ids = parts.map((p) => p.id)
  if (ids.length <= 1) {
    await db(RECORDINGS).where({ id: anyId }).whereNull('ended_at').update({ ended_at: now })
    return
  }
  await db(RECORDINGS).whereIn('id', ids).whereNull('ended_at').update({ ended_at: now })
}

/** Ids of later parts whose first part is one of `headIds` (purge, delete). */
export async function laterPartIds(heads: Array<{ id: string; user: string }>): Promise<string[]> {
  const out: string[] = []
  for (const h of heads) {
    if (!UUID.test(h.id)) continue
    const rows = (await db(RECORDINGS)
      .where('user', h.user)
      .andWhere('meta', 'like', `%"chain":"${h.id}"%`)
      .select('id')) as Array<{ id: string }>
    out.push(...rows.map((r) => r.id))
  }
  return out
}
