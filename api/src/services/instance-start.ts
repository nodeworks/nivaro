/**
 * Pipeline start as a history row (#1219).
 *
 * Every workflow instance begins with ONE nivaro_workflow_history row whose
 * `from_state` is NULL and whose `transition` is NULL: "started in <state>".
 * With it present, time-in-state, SLA clocks, the state track, the approval
 * chain and Team Throughput read the first state from history like every
 * other state instead of falling back to `started_at`.
 *
 * The row is structural, not a note: by default it carries no comment, so the
 * Notes thread (which lists only commented history) never shows it, and it is
 * never a transition — readers that count transitions or send-backs must skip
 * rows with a NULL `from_state` (see `isStartRow`).
 *
 * Leaf module: it imports only the db and the two column probes, so every
 * instance-creation site (routes, GraphQL, hooks, the split engine) can use it
 * without an import cycle through workflow-transitions.
 */
import type { Knex } from 'knex'
import { db as defaultDb } from '../db/index.js'
import { chainFields } from './chain-columns.js'
import { type NoteOrigin, originFields } from './note-authorship.js'

export interface StartHistoryInput {
  instanceId: string
  /** The state the instance starts in (its first current_state). */
  stateId: string
  /** Who started it — null for the system. */
  userId?: string | null
  /** Optional machine-readable comment (split branches carry their JSON). */
  comment?: string | null
  /** person | machine | import | integration. Default: person when a user started it. */
  origin?: NoteOrigin
  /** Defaults to now; pass the instance's started_at so the two agree. */
  timestamp?: Date
}

/** True for a start row: no previous state and no transition. */
export function isStartRow(row: { from_state?: unknown; transition?: unknown }): boolean {
  return (row.from_state == null || row.from_state === '') && row.transition == null
}

/** The origin a start row records when the caller did not say. */
export function startOrigin(
  userId: string | null | undefined,
  comment?: string | null
): NoteOrigin {
  if (/^import:/i.test(String(comment ?? '').trim())) return 'import'
  return userId ? 'person' : 'machine'
}

/** The plain row (no probed columns) — pure, unit-tested. */
export function startHistoryRow(input: StartHistoryInput): Record<string, unknown> {
  return {
    instance: input.instanceId,
    transition: null,
    from_state: null,
    to_state: input.stateId,
    user: input.userId ?? null,
    comment: input.comment ?? null,
    timestamp: input.timestamp ?? new Date()
  }
}

/**
 * Write the start row for a freshly created instance. Spreads `chainFields`
 * and `origin` (both column-probed, so a tenant behind either migration keeps
 * writing). Never throws unless the insert itself fails.
 */
export async function writeStartHistory(
  input: StartHistoryInput,
  database: Knex = defaultDb
): Promise<void> {
  const origin = input.origin ?? startOrigin(input.userId, input.comment)
  await database('nivaro_workflow_history').insert({
    ...(await chainFields('nivaro_workflow_history')),
    ...startHistoryRow(input),
    ...(await originFields('nivaro_workflow_history', origin))
  })
}

// ─── Backfill planning (pure) ────────────────────────────────────────────────

export interface BackfillCandidate {
  id: string
  current_state: string | null
  started_at: Date | string | null
  /** from_state of the instance's earliest history row (null = no history). */
  first_from_state: string | null
  /** timestamp of the instance's earliest history row. */
  first_at: Date | string | null
}

/**
 * The start row a backfill would write for an instance that has none:
 * the state it was in before its first recorded move, else (no history) its
 * current state; stamped at started_at, else at its first history row.
 * Null when there is nothing honest to write.
 */
export function planBackfillStartRow(
  c: BackfillCandidate
): { instance: string; to_state: string; timestamp: Date } | null {
  const toState = c.first_from_state ?? (c.first_at == null ? c.current_state : null)
  if (!toState) return null
  const at = c.started_at ?? c.first_at
  if (at == null) return null
  const ts = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(ts.getTime())) return null
  // The start must sort strictly BEFORE the first recorded move — readers
  // walk history by timestamp, and a tie could put the start row last and make
  // it read as the instance's current state. Legacy seeds share one instant.
  if (c.first_at != null) {
    const first = c.first_at instanceof Date ? c.first_at : new Date(c.first_at)
    if (!Number.isNaN(first.getTime()) && first.getTime() <= ts.getTime())
      return { instance: c.id, to_state: toState, timestamp: new Date(first.getTime() - 1000) }
  }
  return { instance: c.id, to_state: toState, timestamp: ts }
}

/**
 * Narrow a history query to real moves — everything but start rows. For any
 * reader that COUNTS transitions ("transitions today", throughput tiles).
 */
export function excludeStartRows<QB extends Knex.QueryBuilder>(qb: QB, alias?: string): QB {
  const col = (c: string) => (alias ? `${alias}.${c}` : c)
  return qb.where((b) => b.whereNotNull(col('from_state')).orWhereNotNull(col('transition'))) as QB
}

// ─── Backfill SQL (one instance-id range per batch) ─────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The T-SQL for one backfill batch over instances whose id sorts between `lo`
 * and `hi` (inclusive). Dry run SELECTs the counts; execute INSERTs the start
 * rows. Mirrors `planBackfillStartRow`. The bounds are interpolated (runLongSql
 * binds nothing) — they must be uuids read from the database, never input.
 */
export function backfillBatchSql(
  lo: string,
  hi: string,
  opts: { execute: boolean; withOrigin: boolean }
): string {
  if (!UUID_RE.test(lo) || !UUID_RE.test(hi)) throw new Error('backfill bounds must be uuids')
  const cte = `WITH c AS (
  SELECT i.id, i.current_state, i.started_at, f.from_state AS first_from_state, f.[timestamp] AS first_at
  FROM nivaro_workflow_instances i
  OUTER APPLY (
    SELECT TOP 1 h.from_state, h.[timestamp]
    FROM nivaro_workflow_history h
    WHERE h.instance = i.id
    ORDER BY h.[timestamp], h.id
  ) f
  WHERE i.id >= '${lo}' AND i.id <= '${hi}'
    AND NOT EXISTS (
      SELECT 1 FROM nivaro_workflow_history s
      WHERE s.instance = i.id AND s.from_state IS NULL AND s.[transition] IS NULL
    )
), p AS (
  SELECT id,
    COALESCE(first_from_state, CASE WHEN first_at IS NULL THEN current_state END) AS to_state,
    CASE
      WHEN first_at IS NOT NULL AND first_at <= COALESCE(started_at, first_at)
        THEN DATEADD(second, -1, first_at)
      ELSE started_at
    END AS ts
  FROM c
)`
  if (!opts.execute) {
    return `${cte}
SELECT COUNT(*) AS candidates,
  SUM(CASE WHEN to_state IS NOT NULL AND ts IS NOT NULL THEN 1 ELSE 0 END) AS planned
FROM p`
  }
  const originCol = opts.withOrigin ? ', origin' : ''
  const originVal = opts.withOrigin ? ", 'machine'" : ''
  return `${cte}
INSERT INTO nivaro_workflow_history (instance, [transition], from_state, to_state, [user], comment, [timestamp]${originCol})
SELECT id, NULL, NULL, to_state, NULL, NULL, ts${originVal}
FROM p
WHERE to_state IS NOT NULL AND ts IS NOT NULL;
SELECT @@ROWCOUNT AS inserted`
}
