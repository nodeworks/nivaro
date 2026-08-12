// Row-highlight tints for at-risk rule matches (nivaro_at_risk_rules
// highlight_color) — shared by the queue table and CollectionBrowserView.
// Backgrounds are OPAQUE on purpose: pinned sticky cells inherit the row bg
// and semi-transparent tints would let horizontally scrolled content bleed
// through them (same constraint as DataTable selection).

export const ROW_HIGHLIGHT_TINTS: Record<string, { row: string; text: string }> = {
  red: { row: 'bg-[#fdf1f1] dark:bg-[#3a2226]', text: 'text-red-500' },
  amber: { row: 'bg-[#fdf6e9] dark:bg-[#3a2f1d]', text: 'text-amber-500' },
  yellow: { row: 'bg-[#fdfbe8] dark:bg-[#37331b]', text: 'text-yellow-600 dark:text-yellow-400' },
  green: { row: 'bg-[#eefaf2] dark:bg-[#1d3527]', text: 'text-emerald-600 dark:text-emerald-400' },
  blue: { row: 'bg-[#eef5fd] dark:bg-[#1e2f42]', text: 'text-sky-600 dark:text-sky-400' },
  purple: { row: 'bg-[#f6f0fd] dark:bg-[#2f2542]', text: 'text-purple-600 dark:text-purple-400' }
}

export function rowHighlightClass(color?: string | null): string | undefined {
  if (!color) return undefined
  return (ROW_HIGHLIGHT_TINTS[color] ?? ROW_HIGHLIGHT_TINTS.red).row
}

export function rowHighlightTextClass(color?: string | null): string {
  if (!color) return ROW_HIGHLIGHT_TINTS.red.text
  return (ROW_HIGHLIGHT_TINTS[color] ?? ROW_HIGHLIGHT_TINTS.red).text
}
