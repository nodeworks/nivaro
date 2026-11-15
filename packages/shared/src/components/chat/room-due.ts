/** "Due in 5h", "Due in 2d", "3h overdue" — the step clock in words; null without a deadline. */
export function dueText(
  sla: { remaining_hours?: number | null } | null | undefined
): string | null {
  const left = sla?.remaining_hours
  if (left == null || !Number.isFinite(left)) return null
  const span = (h: number) => {
    const a = Math.abs(h)
    if (a < 1) return `${Math.max(1, Math.round(a * 60))}m`
    if (a < 48) return `${Math.round(a)}h`
    return `${Math.round(a / 24)}d`
  }
  // Business-hour clocks say so in the chip's tooltip; the words stay short.
  if (left < 0) return `${span(left)} overdue`
  return `Due in ${span(left)}`
}
