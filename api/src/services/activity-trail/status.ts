import { isMssql } from '../../db/dialect.js'
import { db } from '../../db/index.js'
import { ACTIVITY, readHead, SEALS, trailReady } from './store.js'
import type { CheckpointRow } from './verify.js'

/**
 * "Is the activity trail intact?" — for the Security → Log retention strip, the readiness check
 * and GET /api/activity-trail/status. Cheap: the head (one index seek), the unsealed backlog
 * (the filtered index's row count from sys.partitions on SQL Server), the newest checkpoints.
 */
export type TrailState = 'not_migrated' | 'not_verified' | 'intact' | 'broken' | 'acknowledged'

export interface TrailStatus {
  state: TrailState
  /** Timestamp of the last entry the newest good check covered. */
  intact_through: string | null
  last_verified_at: string | null
  head: { seq: number; id: number | null; at: string | null }
  unsealed: number | null
  oldest_unsealed_at: string | null
  /** The newest checkpoint (whatever its result). */
  last_check: CheckpointSummary | null
  /** The open (unacknowledged) break, when there is one. */
  broken: CheckpointSummary | null
  /** Verified chain position / head position (0–1) — the backfill progress while it runs. */
  verified_share: number | null
}

export interface CheckpointSummary {
  id: number
  kind: string
  verified_at: string
  verified_ok: boolean
  partial: boolean
  from_seq: number
  last_seq: number
  last_id: number | null
  last_hash: string
  last_row_at: string | null
  row_count: number
  bridged_count: number
  mismatch_count: number
  mismatch_first_id: number | null
  mismatch_first_seq: number | null
  mismatch_reason: string | null
  acknowledged_at: string | null
  acknowledged_by: string | null
  acknowledged_note: string | null
}

const iso = (v: unknown): string | null => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export function summariseCheckpoint(r: CheckpointRow): CheckpointSummary {
  return {
    id: Number(r.id),
    kind: r.kind,
    verified_at: iso(r.verified_at) ?? '',
    verified_ok: r.verified_ok === true || r.verified_ok === 1,
    partial: r.partial === true || r.partial === 1,
    from_seq: Number(r.from_seq),
    last_seq: Number(r.last_seq),
    last_id: r.last_id == null ? null : Number(r.last_id),
    last_hash: String(r.last_hash ?? '').trim(),
    last_row_at: iso(r.last_row_at),
    row_count: Number(r.row_count) || 0,
    bridged_count: Number(r.bridged_count) || 0,
    mismatch_count: Number(r.mismatch_count) || 0,
    mismatch_first_id: r.mismatch_first_id == null ? null : Number(r.mismatch_first_id),
    mismatch_first_seq: r.mismatch_first_seq == null ? null : Number(r.mismatch_first_seq),
    mismatch_reason: r.mismatch_reason,
    acknowledged_at: iso(r.acknowledged_at),
    acknowledged_by: r.acknowledged_by,
    acknowledged_note: r.acknowledged_note
  }
}

async function unsealedCount(): Promise<number | null> {
  try {
    if (isMssql(db)) {
      const rows = (await db.raw(
        `SELECT SUM(p.rows) AS n FROM sys.partitions p
           JOIN sys.indexes i ON i.object_id = p.object_id AND i.index_id = p.index_id
          WHERE i.name = 'ix_nivaro_activity_unsealed' AND p.object_id = OBJECT_ID('nivaro_activity')`
      )) as Array<{ n: number | string | null }>
      const n = rows?.[0]?.n
      if (n != null) return Number(n)
    }
    const r = (await db(ACTIVITY).whereNull('seal_hash').count({ n: '*' }).first()) as {
      n: number | string
    }
    return Number(r?.n ?? 0)
  } catch {
    return null
  }
}

/** Pure: the state the strip shows, from the newest checkpoint and the newest open break. */
export function trailStateOf(
  last: CheckpointSummary | null,
  broken: CheckpointSummary | null
): TrailState {
  if (!last) return 'not_verified'
  if (broken) return 'broken'
  if (!last.verified_ok && last.acknowledged_at) return 'acknowledged'
  return last.verified_ok ? 'intact' : 'broken'
}

export async function trailStatus(): Promise<TrailStatus> {
  if (!(await trailReady()))
    return {
      state: 'not_migrated',
      intact_through: null,
      last_verified_at: null,
      head: { seq: 0, id: null, at: null },
      unsealed: null,
      oldest_unsealed_at: null,
      last_check: null,
      broken: null,
      verified_share: null
    }
  const [head, unsealed, oldest, lastRow, goodRow, brokenRow] = await Promise.all([
    readHead(),
    unsealedCount(),
    db(ACTIVITY)
      .whereNull('seal_hash')
      .orderBy('id', 'asc')
      .first('timestamp')
      .catch(() => undefined) as Promise<{ timestamp: Date } | undefined>,
    db(SEALS).orderBy('id', 'desc').first() as Promise<CheckpointRow | undefined>,
    db(SEALS)
      .where((q) => {
        void q.where('verified_ok', true).orWhereNotNull('acknowledged_at')
      })
      .orderBy('last_seq', 'desc')
      .orderBy('id', 'desc')
      .first() as Promise<CheckpointRow | undefined>,
    // A break is OPEN while no later checkpoint is good and it is not acknowledged.
    db(SEALS)
      .where('verified_ok', false)
      .whereNull('acknowledged_at')
      .orderBy('id', 'desc')
      .first() as Promise<CheckpointRow | undefined>
  ])
  const last = lastRow ? summariseCheckpoint(lastRow) : null
  const good = goodRow ? summariseCheckpoint(goodRow) : null
  let broken = brokenRow ? summariseCheckpoint(brokenRow) : null
  // A later good check that walked past the break's position has re-verified that stretch.
  if (broken && good && good.id > broken.id && good.from_seq < (broken.mismatch_first_seq ?? 0))
    broken = null
  return {
    state: trailStateOf(last, broken),
    intact_through: good?.last_row_at ?? null,
    last_verified_at: last?.verified_at ?? null,
    head: { seq: head.seq, id: head.id, at: iso(head.at) },
    unsealed,
    oldest_unsealed_at: iso(oldest?.timestamp),
    last_check: last,
    broken,
    verified_share: head.seq > 0 && good ? Math.min(1, good.last_seq / head.seq) : null
  }
}
