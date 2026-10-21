/**
 * Layout tuned by autofill (#2691): from nivaro_ai_autofill_events, which
 * fields people often change after "Fill from document" proposed a value.
 * The editor suggests a "Check these" section, or a highlight on those fields
 * when the form opens from an autofill proposal (placement overrides
 * `autofill_check`, written through the editor's draft like any change).
 *
 * Counts only: the events hold proposed and final VALUES, which never leave
 * this module — the answer is field names and numbers.
 */

export const MIN_PROPOSED = 3
export const CORRECTED_SHARE = 0.25

export interface AutofillEventRow {
  proposed: unknown
  overrides: unknown
}

export interface CorrectedField {
  field: string
  proposed: number
  corrected: number
  kept: number
  /** corrected / proposed, 0..1 */
  share: number
  /** Often enough to suggest (≥ MIN_PROPOSED proposals, ≥ CORRECTED_SHARE changed). */
  suggest: boolean
}

function list(v: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(v)) return v as Array<Record<string, unknown>>
  if (typeof v !== 'string' || !v) return []
  try {
    const parsed = JSON.parse(v)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Per field: how often a proposed value was kept or changed before Create. */
export function correctedFields(rows: AutofillEventRow[]): CorrectedField[] {
  const by = new Map<string, { proposed: number; corrected: number; kept: number }>()
  for (const r of rows) {
    const changed = new Set(list(r.overrides).map((o) => String(o.field ?? '')))
    const seen = new Set<string>()
    for (const p of list(r.proposed)) {
      const f = String(p.field ?? '')
      if (!f || seen.has(f)) continue
      seen.add(f)
      const agg = by.get(f) ?? { proposed: 0, corrected: 0, kept: 0 }
      agg.proposed++
      if (changed.has(f)) agg.corrected++
      else if (p.kept) agg.kept++
      by.set(f, agg)
    }
  }
  return [...by.entries()]
    .map(([field, a]) => {
      const share = a.proposed ? a.corrected / a.proposed : 0
      return {
        field,
        ...a,
        share,
        suggest: a.proposed >= MIN_PROPOSED && share >= CORRECTED_SHARE
      }
    })
    .sort(
      (a, b) => b.share - a.share || b.corrected - a.corrected || a.field.localeCompare(b.field)
    )
}
