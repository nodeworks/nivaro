import { db } from '../db/index.js'
import { cosineSim, embedText } from './embeddings.js'

/**
 * Search chat by meaning (#2354). One embedding per message in
 * nivaro_chat_embeddings (migration 430), written fire-and-forget when a
 * message is sent and filled in lazily by `backfillRooms` for older history.
 *
 * VISIBILITY: the caller passes the room set it already resolved through
 * listRooms (canSeeRoom's own rule) and every query here is limited to it —
 * a vector row is never read for a room outside that list.
 */

const MIN_CHARS = 12
/** Rows scored per search — newest first. */
const SCAN_CAP = 4000
/** Messages embedded lazily per search so old history fills in over time. */
const BACKFILL_PER_SEARCH = 25
/** Local hash embeddings separate poorly (lexical only); neural ones better. */
const THRESHOLD_NEURAL = 0.45
const THRESHOLD_LOCAL = 0.3

let tableOk: boolean | null = null
let probedAt = 0
async function embeddingsTable(): Promise<boolean> {
  if (tableOk === true) return true
  if (tableOk === false && Date.now() - probedAt < 60_000) return false
  try {
    tableOk = await db.schema.hasTable('nivaro_chat_embeddings')
  } catch {
    tableOk = false
  }
  probedAt = Date.now()
  return tableOk
}

/** Text worth embedding: not a platform line, long enough to carry meaning. Pure. */
export function embeddableText(message: string | null | undefined): string | null {
  const t = String(message ?? '')
    .replace(/@\[([^\]]+)\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length >= MIN_CHARS ? t.slice(0, 2000) : null
}

/**
 * Score stored vectors against a query vector, best first. Pure.
 * `threshold` drops weak matches; ids in `exclude` (already shown as exact) are skipped.
 */
export function rankByMeaning(
  query: number[],
  rows: Array<{ message_id: number; embedding: string }>,
  opts: { threshold: number; limit: number; exclude?: Set<number> }
): Array<{ id: number; score: number }> {
  const out: Array<{ id: number; score: number }> = []
  for (const r of rows) {
    const id = Number(r.message_id)
    if (opts.exclude?.has(id)) continue
    let vec: unknown
    try {
      vec = JSON.parse(r.embedding)
    } catch {
      continue
    }
    if (!Array.isArray(vec)) continue
    const score = cosineSim(query, vec as number[])
    if (score >= opts.threshold) out.push({ id, score })
  }
  out.sort((a, b) => b.score - a.score || b.id - a.id)
  return out.slice(0, opts.limit)
}

/** Index one message. Never throws — search quality must not break sending. */
export async function indexChatMessage(
  id: number,
  room: string,
  message: string,
  isSystem = false
): Promise<void> {
  try {
    if (isSystem || !(await embeddingsTable())) return
    const text = embeddableText(message)
    if (!text) return
    const vec = await embedText(text)
    await db('nivaro_chat_embeddings')
      .insert({ message_id: id, room, embedding: JSON.stringify(vec) })
      .catch(() => {}) // UNIQUE race — already indexed
  } catch {
    /* indexing is best-effort */
  }
}

async function backfillRooms(rooms: string[]): Promise<void> {
  const missing = (await db('chat_messages as m')
    .leftJoin('nivaro_chat_embeddings as e', 'e.message_id', 'm.id')
    .whereIn('m.room', rooms)
    .whereNull('m.deleted_at')
    .whereNull('e.message_id')
    .whereRaw('LEN(m.message) >= ?', [MIN_CHARS])
    .orderBy('m.id', 'desc')
    .limit(BACKFILL_PER_SEARCH)
    .select('m.id', 'm.room', 'm.message')) as Array<{ id: number; room: string; message: string }>
  for (const m of missing) await indexChatMessage(Number(m.id), m.room, m.message)
}

export interface MeaningHit {
  id: number
  score: number
}

/**
 * Messages in `rooms` whose meaning is close to `q`. Returns [] when the
 * table is absent. `rooms` MUST already be limited to what the asker can see.
 */
export async function searchByMeaning(
  q: string,
  rooms: string[],
  opts: { limit?: number; exclude?: Set<number> } = {}
): Promise<MeaningHit[]> {
  if (!rooms.length || !(await embeddingsTable())) return []
  const text = embeddableText(q) ?? q.trim()
  if (text.length < 3) return []
  await backfillRooms(rooms.slice(0, 200)).catch(() => {})
  const qv = await embedText(text)
  const rows = (await db('nivaro_chat_embeddings')
    .whereIn('room', rooms.slice(0, 200))
    .orderBy('message_id', 'desc')
    .limit(SCAN_CAP)
    .select('message_id', 'embedding')) as Array<{ message_id: number; embedding: string }>
  // A 512-dim local vector vs a 1024-dim neural one never compare (cosineSim
  // returns 0 on a length mismatch), so mixed history simply scores low.
  const neural = qv.length !== 512
  return rankByMeaning(qv, rows, {
    threshold: neural ? THRESHOLD_NEURAL : THRESHOLD_LOCAL,
    limit: opts.limit ?? 20,
    exclude: opts.exclude
  })
}

/** Forget vectors of messages that were deleted. */
export async function dropEmbedding(id: number): Promise<void> {
  try {
    if (await embeddingsTable()) await db('nivaro_chat_embeddings').where('message_id', id).del()
  } catch {
    /* best effort */
  }
}
