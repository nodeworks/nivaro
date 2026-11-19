/**
 * Collection imports match a file row to an existing record on one or more fields (like staged
 * imports' service_config `match_by`). EFP prod 2026-11-19: a warehouse inventory file re-run
 * with "Overwrite" and no match field created every row again (16k duplicates); its rows are
 * only unique on warehouse + CIFA together.
 *
 * The fields live in nivaro_import_jobs.id_field / nivaro_import_mappings.id_field (no
 * migration): one name stays a plain name ("code"), several are a comma list
 * ("warehouse,cifa"); a JSON array is read too. Matching compares the RESOLVED values (an M2O
 * cell's record id after the link resolver), every field must be equal, null-safe (an empty cell
 * matches an empty column). A row whose match fields are all empty cannot match: it is created.
 * Two or more existing records matching one row is that row's error, never a pick.
 *
 * Pure: no database.
 */

const NAME = /^[A-Za-z_][\w]*$/

/** The match fields a stored id_field (or a request body value) names, in order, no repeats. */
export function parseMatchFields(raw: unknown): string[] {
  let list: unknown[] = []
  if (Array.isArray(raw)) list = raw
  else if (typeof raw === 'string') {
    const s = raw.trim()
    if (!s) return []
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s)
        list = Array.isArray(parsed) ? parsed : []
      } catch {
        list = []
      }
    } else list = s.split(',')
  }
  const out: string[] = []
  for (const v of list) {
    const name = String(v ?? '').trim()
    if (name && NAME.test(name) && !out.includes(name)) out.push(name)
  }
  return out
}

/** How match fields are stored: one plain name, several as a comma list, none as null. */
export function storeMatchFields(raw: unknown): string | null {
  const fields = parseMatchFields(raw)
  return fields.length ? fields.join(',') : null
}

/** A cell as matching sees it: blank text is "no value" (matches NULL). */
export function matchValue(v: unknown): unknown {
  if (v == null) return null
  if (typeof v === 'string' && v.trim() === '') return null
  return v
}

/** The row's values for the match fields, and whether any of them carries a value. */
export function rowMatchValues(
  row: Record<string, unknown>,
  fields: string[]
): { values: unknown[]; usable: boolean } {
  const values = fields.map((f) => matchValue(row[f]))
  return { values, usable: fields.length > 0 && values.some((v) => v != null) }
}

/**
 * A key equal for two value lists the database would call equal: numbers and numeric text
 * agree ("12" = 12), text compares trimmed and case-insensitively (the default collation),
 * dates by instant, empty = empty.
 */
export function matchKey(values: unknown[]): string {
  return JSON.stringify(
    values.map((v) => {
      const x = matchValue(v)
      if (x == null) return null
      if (x instanceof Date) return `d:${x.getTime()}`
      if (typeof x === 'boolean') return x ? 'n:1' : 'n:0'
      const s = String(x).trim()
      if (s !== '' && Number.isFinite(Number(s)) && /^[+-]?\d*\.?\d+$/.test(s))
        return `n:${Number(s)}`
      return `s:${s.toLowerCase()}`
    })
  )
}

/** "Warehouse 'Main' and CIFA '1234'" — the match fields as a person reads them. */
export function describeMatch(
  fields: string[],
  shown: Record<string, unknown>,
  labelOf: (field: string) => string
): string {
  const parts = fields.map((f) => {
    const v = matchValue(shown[f])
    return v == null ? `${labelOf(f)} empty` : `${labelOf(f)} '${String(v).slice(0, 60)}'`
  })
  return parts.length <= 1
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** The row error for a row two or more existing records match. */
export function ambiguousMatchText(described: string): string {
  return `More than one existing record matches ${described} — the import cannot tell which one to update. Add a match field that tells them apart, or remove the duplicates first.`
}
