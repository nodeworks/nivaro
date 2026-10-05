import { junctionExists } from './junction-exists.js'
import { lastSuccessGrouped } from './last-success-grouped.js'
import { tempTableGuard } from './temp-table-guard.js'

export interface Transformer {
  id: string
  /** The rewritten body + one note per change, or null when the shape is absent. */
  apply(body: string): { body: string; notes: string[] } | null
}

/** Order matters: result-changing-shape rewrites first, the guard last (it only adds lines). */
export const TRANSFORMERS: Transformer[] = [junctionExists, lastSuccessGrouped, tempTableGuard]

/** `exclude` skips transformers by id (stored-procedure bodies skip 'temp-table-guard'). */
export function applyTransformers(
  body: string,
  opts: { exclude?: string[] } = {}
): { body: string; notes: string[]; applied: string[] } | null {
  let cur = body
  const notes: string[] = []
  const applied: string[] = []
  for (const t of TRANSFORMERS) {
    if (opts.exclude?.includes(t.id)) continue
    const r = t.apply(cur)
    if (!r) continue
    cur = r.body
    notes.push(...r.notes)
    applied.push(t.id)
  }
  return applied.length ? { body: cur, notes, applied } : null
}
