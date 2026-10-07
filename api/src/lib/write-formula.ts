/** When a write-time computed column re-derives on UPDATE.
 *
 *  Server formulas read `item.<column>`. A write-computed column used to be
 *  recomputed on every update of its row, so a row loaded with a stored value
 *  that does not equal its formula (a purchase-order line copied over as it
 *  was) lost that value on the first unrelated edit. The rule: re-derive only
 *  when one of the formula's inputs is in the payload AND differs from the
 *  stored value. A create, or an update with no stored row, always derives. */

const ITEM_REF = /\bitem\.([A-Za-z_][A-Za-z0-9_]*)/g

export function writeFormulaInputs(formula: string): string[] {
  const out: string[] = []
  for (const m of String(formula ?? '').matchAll(ITEM_REF)) if (!out.includes(m[1])) out.push(m[1])
  return out
}

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

/** True when `payload` changes one of the formula's inputs relative to the
 *  stored row `previous`. No previous row or a formula with no inputs → true. */
export function shouldRecomputeWriteField(
  formula: string,
  payload: Record<string, unknown>,
  previous: Record<string, unknown> | null | undefined
): boolean {
  if (!previous) return true
  const inputs = writeFormulaInputs(formula)
  if (inputs.length === 0) return true
  return inputs.some((k) => k in payload && !sameStoredValue(payload[k], previous[k]))
}
