export interface AddendumAmounts {
  previous: number | null
  next: number | null
  /** next − previous; the stored cost_impact wins when present. */
  change: number | null
}

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Previous / new / change amount for an addendum card. Stored columns win; a
 * pending addendum has them null, so fall back to the live figures the card
 * computes (current record value → proposed value).
 */
export function resolveAddendumAmounts(
  stored: { previous_amount?: unknown; new_amount?: unknown; cost_impact?: unknown },
  live: { previous: number | null; next: number | null } | null
): AddendumAmounts {
  const previous = num(stored.previous_amount) ?? live?.previous ?? null
  const next = num(stored.new_amount) ?? live?.next ?? null
  const impact = num(stored.cost_impact)
  const diff = previous != null && next != null ? Math.round((next - previous) * 100) / 100 : null
  return { previous, next, change: impact ?? diff }
}
