/**
 * How the Theirs / Mine chooser shows a value (army 11 f4 M1): a money total
 * read "18.900000000000002" and "10.5" while the grid showed "$18.90" — in a
 * decision dialog that reads like the system computed a wrong amount. Numbers
 * lose their float artefacts; money-named fields read as dollars. Leaf module.
 */

const MONEY_FIELD = /(^|_)(total|amount|price|cost|subtotal|spend|budget)s?($|_)/i

/** Whether a field holds money, by its name (the grids' own currency columns). */
export function isMoneyFieldName(field: string): boolean {
  return MONEY_FIELD.test(field)
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(v.trim())) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** The value as a person reads it, or null when it is not a number (the
 *  dialog's own text handling applies then). */
export function collisionNumberText(field: string, v: unknown): string | null {
  const n = asNumber(v)
  if (n == null) return null
  // 18.900000000000002 → 18.9: twelve significant digits drop the artefact.
  const clean = Number(n.toPrecision(12))
  if (isMoneyFieldName(field))
    return clean.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })
  return clean.toLocaleString('en-US', { maximumFractionDigits: 6 })
}

/** Long texts that share a long start are shown from just before they differ
 *  ("…test A S1 B2 B3" / "…test A S1 B2 S3"), so the change is visible
 *  without comparing character by character (army 11 f4 design review). */
export function differingTails(
  a: string,
  b: string,
  keep = 12,
  minShared = 24
): { a: string; b: string } {
  let p = 0
  const max = Math.min(a.length, b.length)
  while (p < max && a[p] === b[p]) p++
  if (p < minShared) return { a, b }
  // Start at a word boundary when one is close, so the tail never opens mid-word.
  let from = Math.max(0, p - keep)
  const space = a.lastIndexOf(' ', from)
  if (space > 0 && from - space <= 8) from = space + 1
  return { a: `…${a.slice(from)}`, b: `…${b.slice(from)}` }
}
