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

/** Text columns a fallback search (no field metadata) never reads: secrets, images, JSON. */
const NEVER_SEARCHED = /password|token|secret|totp|external_id/i
const NOT_SEARCHABLE = /avatar|preferences|last_page|_directory$|^directory_|^entra_|_json$|^data$/i
/** What a person search reads: who they are, not what is stored about them. */
const PEOPLE_SEARCH_COLUMNS: Record<string, string[]> = {
  nivaro_users: [
    'first_name',
    'last_name',
    'email',
    'title',
    'department',
    'company',
    'office_location',
    'city',
    'employee_id'
  ]
}

/**
 * The columns a list search reads on a collection with no field metadata
 * (nivaro_users is served from virtual meta), from the table's own text
 * columns. Never a secret (matching one would let a caller confirm a token by
 * probing for it) and never a blob: an avatar is a base64 data URI and
 * preferences / *_directory are JSON — "Robert Lee" matched Glo Dendy through
 * her avatar bytes and her manager's name (2026-10-28). People collections
 * search the person columns only.
 */
export function fallbackSearchColumns(collection: string, textCols: string[]): string[] {
  const cols = textCols.filter((c) => !NEVER_SEARCHED.test(c) && !NOT_SEARCHABLE.test(c))
  const people = PEOPLE_SEARCH_COLUMNS[collection]
  if (!people) return cols
  const kept = cols.filter((c) => people.includes(c))
  return kept.length ? kept : cols
}
