/** A field name's words: `fiscal_year` / `fiscalYear` / `fiscal-year` → fiscal, year. */
function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

const YEAR_WORDS = new Set(['year', 'years', 'yr', 'fy'])
/** What a year lookup's own number is called (`funding_years.value`). */
const YEAR_IDENTITY_LEAVES = new Set(['value', 'name', 'label', 'number', 'code', 'year'])

/**
 * Which queue columns a group header may total (army 8 b08-N5). A number
 * format alone is not enough: "Funding Year: 24315" summed twelve 2026s.
 * Identifiers (an `id` / `*_id` leaf) and years are numbers nobody adds up.
 * A year is a name whose LAST word is year (`year`, `fiscal_year`,
 * `funding_year`, `fiscalYear`) or a year lookup's own number
 * (`funding_years.value`) — a name that merely contains it is an amount
 * (`prior_year_spend`, `yearly_total` are totalled; army8 review LOW).
 */
export function isSummableColumn(path: string): boolean {
  const segments = path.split('.')
  const leaf = segments[segments.length - 1] ?? path
  if (leaf === 'id' || /_id$/i.test(leaf) || /[a-z]Id$/.test(leaf)) return false
  const leafWords = nameTokens(leaf)
  if (YEAR_WORDS.has(leafWords[leafWords.length - 1] ?? '')) return false
  const parent = segments.length > 1 ? nameTokens(segments[segments.length - 2]) : []
  if (
    YEAR_WORDS.has(parent[parent.length - 1] ?? '') &&
    YEAR_IDENTITY_LEAVES.has(leaf.toLowerCase())
  )
    return false
  return true
}

/** The paths a grouped table asks the server to total per group. Pure. */
export function groupSumPathsFor(
  queue:
    | {
        extra_field_meta?: Array<{ path: string; aggregate?: string | null }> | null
        sources?: Array<{
          type?: string | null
          column_formats?: Record<string, { type?: string } | null | undefined> | null
        }> | null
      }
    | null
    | undefined
): string[] {
  const paths = new Set<string>()
  for (const m of queue?.extra_field_meta ?? []) {
    // An aggregate the admin set on purpose is kept.
    if (m.aggregate && m.aggregate !== 'count') paths.add(m.path)
  }
  for (const src of queue?.sources ?? []) {
    for (const [p, cfg] of Object.entries(src.column_formats ?? {})) {
      if (cfg?.type === 'number' && isSummableColumn(p)) paths.add(p)
    }
    if (src.type === 'addendums') paths.add('cost_impact')
  }
  return [...paths].slice(0, 12)
}
