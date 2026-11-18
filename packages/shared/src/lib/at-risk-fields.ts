/**
 * The fields an at-risk rule reads (B5 review, realtime gaps C4): its condition fields AND a
 * `{{other_field}}` reference in a condition value (optionally `* <num>` / `+ <num>`), e.g.
 * `spent > {{budget}} * 1.1` reads budget too.
 *
 * TWIN of api/src/routes/at-risk.ts `referencedFields` / `FIELD_REF_RE` — at-risk-fields.test.ts
 * compares the two regexes, so change both together.
 */
export const AT_RISK_FIELD_REF_RE =
  /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}(?:\s*([*+])\s*(-?\d+(?:\.\d+)?))?$/
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function atRiskReferencedFields(
  conditions: ReadonlyArray<{ field?: unknown; value?: unknown }> | null | undefined
): string[] {
  const fields = new Set<string>()
  for (const c of conditions ?? []) {
    if (!c || typeof c !== 'object') continue
    if (typeof c.field === 'string' && IDENTIFIER_RE.test(c.field)) fields.add(c.field)
    if (typeof c.value === 'string') {
      const m = AT_RISK_FIELD_REF_RE.exec(c.value.trim())
      if (m) fields.add(m[1])
    }
  }
  return [...fields]
}
