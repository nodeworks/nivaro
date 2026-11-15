import { emitRecordEvent } from './record-events.js'

/**
 * "Recalculating" on totals (realtime round 7, item 9).
 *
 * While a nested child set is written onto an existing record, the stored rollups it feeds are
 * recalculated ONCE at the end (services/items.ts applyAliasO2MWrites skips the per-row recalc),
 * so an open page would show the old total as if it were final while the lines under it change.
 * The record room hears:
 *
 *   record:recalc { collection, item, phase: 'start' | 'done', fields: [rollup field names] }
 *
 * Names only, never a figure; only sockets that joined the record room (a read check) hear it,
 * and a client keeps only the fields its own field list carries. The page shows "Updating…" on
 * those fields from `start` until `done` and the re-read that follows it; a recalculation that
 * moved a figure also announces the field itself (rollups.ts), as before. Best-effort: an
 * emit never affects the write.
 */

export type RecalcPhase = 'start' | 'done'

export function announceRecalc(
  collection: string,
  item: string | number,
  phase: RecalcPhase,
  fields: string[],
  emit: typeof emitRecordEvent = emitRecordEvent
): void {
  if (!collection || item == null || item === '' || fields.length === 0) return
  try {
    emit(collection, item, 'record:recalc', { phase, fields: fields.slice(0, 50) })
  } catch {
    /* decoration */
  }
}
