import { choiceLabel } from '../../lib/utils'

// Small pure helpers of the worklist (army 11), kept out of QueueWorklist.tsx so
// tests do not load the whole component graph.

/** A stored select value as its choice label ("at_risk" → "At Risk"); others unchanged. */
export function extraChoiceText(
  meta: { choices?: Array<{ value: string; text: string }> } | undefined,
  value: string
): string {
  const hit = meta?.choices?.find((c) => c.value === value)
  return hit ? choiceLabel(hit.text) : value
}

/** "On hold 144 · Sent back 4" — only when more than one rule makes up At Risk, or the one
 *  rule is not obvious; biggest first (army 11 Q1-6: 148 at risk were 144 parked). */
export function atRiskBreakdown(byRule: Record<string, number> | null | undefined): string | null {
  const parts = Object.entries(byRule ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (parts.length === 0) return null
  return parts.map(([name, n]) => `${name} ${n.toLocaleString('en-US')}`).join(' · ')
}

/**
 * Whether a key event belongs to the worklist's list keys (j/k/arrows/c/o): only on
 * the page itself or on a focused table row (army 11 N10). Buttons, links, menus,
 * fields and anything inside a dialog or popover keep their own keys.
 */
export function worklistKeyTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return true
  const el = target as HTMLElement
  if (el === document.body || el === document.documentElement) return true
  if (el.tagName === 'TR' && el.hasAttribute('data-row-key')) return true
  return false
}
