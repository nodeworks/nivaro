import { db } from '../../db/index.js'
import { getTenantId } from '../../db/tenant-context.js'
import { hasColumn } from '../../lib/column-probe.js'
import { allCanonicalColumns, GENESIS_HASH } from './canonical.js'
import type { Anchor, Bridge, WalkRow } from './chain.js'

/** Database reads shared by the sealer, the verifier, the purge and the evidence export. */

export const ACTIVITY = 'nivaro_activity'
export const SEALS = 'nivaro_activity_seals'
export const BRIDGES = 'nivaro_activity_seal_bridges'

const tableProbe = new Map<string, { ok: boolean; at: number }>()
const MISS_TTL_MS = 60_000

async function hasTableCached(table: string): Promise<boolean> {
  const key = `${getTenantId() ?? ''}:${table}`
  const hit = tableProbe.get(key)
  if (hit && (hit.ok || Date.now() - hit.at < MISS_TTL_MS)) return hit.ok
  const ok = await db.schema.hasTable(table).catch(() => false)
  tableProbe.set(key, { ok, at: Date.now() })
  return ok
}

/** Migration 518 has run on this database (columns + both tables). */
export async function trailReady(): Promise<boolean> {
  const [a, b, c, d, e] = await Promise.all([
    hasColumn(ACTIVITY, 'seal_hash'),
    hasColumn(ACTIVITY, 'seal_seq'),
    hasColumn(ACTIVITY, 'seal_version'),
    hasTableCached(SEALS),
    hasTableCached(BRIDGES)
  ])
  return a && b && c && d && e
}

/** The canonical columns this database has (a missing one reads as null in the hash). */
export async function presentCanonicalColumns(): Promise<string[]> {
  const cols = allCanonicalColumns()
  const present = await Promise.all(
    cols.map((c) => (c === 'id' ? Promise.resolve(true) : hasColumn(ACTIVITY, c)))
  )
  return cols.filter((_, i) => present[i])
}

export const trimHash = (v: unknown): string => String(v ?? '').trim()

/** The newest sealed row (the chain head), or genesis. */
export async function readHead(): Promise<Anchor & { id: number | null; at: Date | null }> {
  const row = (await db(ACTIVITY)
    .whereNotNull('seal_seq')
    .orderBy('seal_seq', 'desc')
    .first('id', 'seal_seq', 'seal_hash', 'timestamp')) as
    | { id: number; seal_seq: number | string; seal_hash: string; timestamp: Date }
    | undefined
  if (!row) return { seq: 0, hash: GENESIS_HASH, id: null, at: null }
  return {
    seq: Number(row.seal_seq),
    hash: trimHash(row.seal_hash),
    id: Number(row.id),
    at: row.timestamp ?? null
  }
}

/** Sealed rows with seq in (afterSeq, throughSeq], in chain order. */
export async function readWalkRows(
  afterSeq: number,
  throughSeq: number,
  limit: number,
  columns: string[]
): Promise<WalkRow[]> {
  const rows = (await db(ACTIVITY)
    .where('seal_seq', '>', afterSeq)
    .where('seal_seq', '<=', throughSeq)
    .orderBy('seal_seq', 'asc')
    .limit(limit)
    .select([...new Set([...columns, 'seal_seq', 'seal_hash', 'seal_version'])])) as Array<
    Record<string, unknown>
  >
  return rows.map(toWalkRow)
}

export function toWalkRow(r: Record<string, unknown>): WalkRow {
  return {
    id: Number(r.id),
    seq: Number(r.seal_seq),
    hash: trimHash(r.seal_hash),
    version: r.seal_version == null ? null : Number(r.seal_version),
    at: (r.timestamp as Date | string | null) ?? null,
    row: r
  }
}

/** Bridges for the given surviving rows (activity id → predecessor's hash). */
export async function loadBridges(ids: number[]): Promise<Map<number, Bridge>> {
  const out = new Map<number, Bridge>()
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000)
    if (!chunk.length) continue
    const rows = (await db(BRIDGES)
      .whereIn('activity_id', chunk)
      .select('activity_id', 'prev_hash', 'prev_seq')) as Array<{
      activity_id: number
      prev_hash: string
      prev_seq: number | string
    }>
    for (const b of rows)
      out.set(Number(b.activity_id), {
        prev_hash: trimHash(b.prev_hash),
        prev_seq: Number(b.prev_seq)
      })
  }
  return out
}

/** Ids among `rows` whose predecessor is not the row right before them (bridge candidates). */
export function gapIds(anchorSeq: number, rows: WalkRow[]): number[] {
  const out: number[] = []
  let prev = anchorSeq
  for (const r of rows) {
    if (r.seq !== prev + 1) out.push(r.id)
    prev = r.seq
  }
  return out
}
