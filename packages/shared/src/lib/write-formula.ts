/** Which stored values a write-time formula re-derives from, and when.
 *
 *  A write-computed column (`amount = {{price}} * {{quantity}}`) used to be
 *  recomputed on EVERY save of its row. A row loaded with a stored value that
 *  does not equal the formula (a purchase-order line copied over as it was,
 *  where the ordered quantity and the billed amount legitimately differ) then
 *  lost that value the first time anyone touched the row for an unrelated
 *  reason. The rule now: a formula re-derives only when one of its inputs
 *  changed. Untouched inputs keep the stored figure. */

const TOKEN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z0-9_.]+)?\s*\}\}/g

/** The row columns a `{{token}}` formula reads (first path segment, deduped). */
export function formulaInputs(formula: string): string[] {
  const out: string[] = []
  for (const m of String(formula ?? '').matchAll(TOKEN)) if (!out.includes(m[1])) out.push(m[1])
  return out
}

/** Loose equality for stored-vs-draft values: null, undefined and '' agree;
 *  numeric strings agree with numbers; everything else compares as strings. */
export function sameStoredValue(a: unknown, b: unknown): boolean {
  const ea = a === null || a === undefined || a === ''
  const eb = b === null || b === undefined || b === ''
  if (ea || eb) return ea && eb
  const na = typeof a === 'number' ? a : Number(a)
  const nb = typeof b === 'number' ? b : Number(b)
  if (
    Number.isFinite(na) &&
    Number.isFinite(nb) &&
    String(a).trim() !== '' &&
    String(b).trim() !== ''
  ) {
    return Math.abs(na - nb) < 1e-9
  }
  return String(a) === String(b)
}

/** True when the formula should re-derive for `draft` against the stored
 *  `base`: no base (a new row), a formula with no inputs, or any input whose
 *  draft value differs from the stored one. */
export function formulaInputsChanged(
  formula: string,
  draft: Record<string, unknown>,
  base: Record<string, unknown> | null | undefined
): boolean {
  if (!base) return true
  const inputs = formulaInputs(formula)
  if (inputs.length === 0) return true
  return inputs.some((k) => k in draft && !sameStoredValue(draft[k], base[k]))
}
