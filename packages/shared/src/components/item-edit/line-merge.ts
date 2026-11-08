/**
 * Merge for a line someone else saved while you edited it (Rob, army 11): a
 * third way out of the Theirs / Mine chooser. A 3-way merge per field between
 * the line as it was loaded (base), the newer save (theirs) and this person's
 * edit (mine):
 *
 *   - only they changed it  → theirs (it is not in this edit: nothing is sent)
 *   - only I changed it     → mine (in the edit, not a server conflict)
 *   - both, to the same value → that value (nothing to ask)
 *   - both, to different values → a real conflict: the person picks, nothing
 *     is preselected, and the merged save waits until every one is picked
 *
 * The server's mid-air check already says which written fields changed since
 * the base (`conflicts`), so the classification needs no base values. Derived
 * fields (write-computed: amount = price × quantity) are never merged: they
 * are left out of the choice and recomputed from the merged inputs. The save
 * itself is the normal guarded update of the fields that stay "mine", against
 * the newer revision — no new trust in the client. Leaf module.
 */

import { evaluateNumeric } from '../../lib/expression'
import { sameStoredValue } from '../../lib/write-formula'
import { type LineCollision, lineConflictKey } from './line-midair'

export type MergeKind = 'same' | 'conflict' | 'derived'

export interface MergeField {
  /** `lineConflictKey` — what the chooser's onResolve speaks. */
  key: string
  field: string
  theirs: unknown
  mine: unknown
  kind: MergeKind
}

export interface DerivedField {
  field: string
  formula: string
}

/** Each server-reported conflict of a line, classified for the merge. */
export function classifyLineConflicts(line: LineCollision): MergeField[] {
  const derived = new Set((line.derived ?? []).map((d) => d.field))
  return line.conflicts.map((c) => {
    const mine = line.mine[c.field]
    const kind: MergeKind = derived.has(c.field)
      ? 'derived'
      : sameStoredValue(c.current_value, mine)
        ? 'same'
        : 'conflict'
    return {
      key: lineConflictKey(line, c.field),
      field: c.field,
      theirs: c.current_value,
      mine,
      kind
    }
  })
}

/** Whether every real conflict has a pick. */
export function mergeReady(
  fields: MergeField[],
  picks: ReadonlyMap<string, 'theirs' | 'mine'>
): boolean {
  return fields.every((f) => f.kind !== 'conflict' || picks.has(f.key))
}

/**
 * The chooser's answer for a merge: the keys that stay THEIRS (left out of the
 * re-sent edit). Same-value and derived fields are theirs (nothing to write;
 * a derived one re-derives on the server from the inputs that are sent);
 * a real conflict is theirs unless "mine" was picked.
 */
export function mergeTheirsKeys(
  fields: MergeField[],
  picks: ReadonlyMap<string, 'theirs' | 'mine'>
): Set<string> {
  const out = new Set<string>()
  for (const f of fields) if (f.kind !== 'conflict' || picks.get(f.key) !== 'mine') out.add(f.key)
  return out
}

/** Recompute derived fields from `row` (a formula that cannot be evaluated keeps the value). */
export function recomputeDerived(
  row: Record<string, unknown>,
  derived: DerivedField[] | undefined
): Record<string, unknown> {
  if (!derived?.length) return row
  const next = { ...row }
  for (const d of derived) {
    const v = evaluateNumeric(d.formula, next)
    if (v !== null && Number.isFinite(v)) next[d.field] = Math.round(v * 1e6) / 1e6
  }
  return next
}

/**
 * The line as the merged save would leave it: the newer row (theirs), this
 * person's non-conflicting changes, each conflict's pick (unpicked = theirs
 * for now), derived fields recomputed from the result. `current` absent = the
 * conflicting fields and this edit alone.
 */
export function mergedLinePreview(
  line: LineCollision,
  picks: ReadonlyMap<string, 'theirs' | 'mine'>
): Record<string, unknown> {
  const fields = classifyLineConflicts(line)
  const conflictFields = new Set(fields.map((f) => f.field))
  const derived = new Set((line.derived ?? []).map((d) => d.field))
  const row: Record<string, unknown> = { ...(line.current ?? {}) }
  for (const [k, v] of Object.entries(line.edit ?? line.mine)) {
    if (k.startsWith('_') || k === 'id' || conflictFields.has(k) || derived.has(k)) continue
    row[k] = v
  }
  for (const f of fields) {
    if (f.kind === 'derived') continue
    row[f.field] = f.kind === 'conflict' && picks.get(f.key) === 'mine' ? f.mine : f.theirs
  }
  return recomputeDerived(row, line.derived)
}

/** The fields a preview shows: everything this edit or the conflict touched,
 *  plus the derived ones — never ids, bookkeeping keys or hidden fields. */
export function previewFields(line: LineCollision, hide?: (field: string) => boolean): string[] {
  const out: string[] = []
  const add = (f: string) => {
    if (out.includes(f) || f === 'id' || f.startsWith('_') || /_id$/.test(f)) return
    if (hide?.(f)) return
    out.push(f)
  }
  for (const k of Object.keys(line.edit ?? line.mine)) add(k)
  for (const c of line.conflicts) add(c.field)
  for (const d of line.derived ?? []) add(d.field)
  return out
}
