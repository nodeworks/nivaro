/**
 * One PATCH body for a bulk staleness edit on the stale-import signal's
 * settings: `cadence_hours:<import key>` per selected import — a number of
 * hours, 0 (stop monitoring) or null (back to the default).
 */
export type BulkCadenceMode = 'hours' | 'default' | 'off'

export function bulkCadenceBody(
  keys: readonly string[],
  mode: BulkCadenceMode,
  hours?: number | null
): Record<string, number | null> {
  const value = mode === 'hours' ? (hours ?? null) : mode === 'off' ? 0 : null
  const body: Record<string, number | null> = {}
  for (const key of new Set(keys)) body[`cadence_hours:${key}`] = value
  return body
}
