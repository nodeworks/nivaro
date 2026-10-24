/**
 * Per-collection list-search columns: `nivaro_collections.browser_config.search_fields`.
 *
 * A list `?search=` matches `%term%` against every string and text field. On a
 * wide table that includes long narrative columns (EFP workflows: objective,
 * overview, considerations, risks… 13 of them, nvarchar(max)), and a LIKE over
 * those reads every LOB page — 2.3–2.6 s per search with no match, 0.8 s
 * without them (staging army test 2026-10-23: 5–9 s under load). Naming the
 * columns people actually search by keeps search on them only.
 *
 * Unset, empty or malformed = every string/text field, as before. The list only
 * ever narrows: a name that is not a string/text field of the collection is
 * ignored, so it never widens what a caller can match on.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

export function parseSearchFields(browserConfig: unknown): string[] | null {
  try {
    const bc =
      typeof browserConfig === 'string'
        ? (JSON.parse(browserConfig) as Record<string, unknown>)
        : (browserConfig as Record<string, unknown> | null)
    const raw = bc?.search_fields
    if (!Array.isArray(raw)) return null
    const names = raw.map((v) => String(v ?? '').trim()).filter((v) => IDENT.test(v))
    return names.length ? [...new Set(names)] : null
  } catch {
    return null
  }
}

/** The searchable columns narrowed to the configured list; a configured list
 *  that matches none of them falls back to all of them (search never goes
 *  silently empty). */
export function narrowSearchColumns(searchable: string[], configured: string[] | null): string[] {
  if (!configured) return searchable
  const want = new Set(configured)
  const kept = searchable.filter((c) => want.has(c))
  return kept.length ? kept : searchable
}
