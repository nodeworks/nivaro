/**
 * Collection imports match a file row to an existing record on one or more fields (like staged
 * imports' service_config `match_by`). EFP prod 2026-11-19: a warehouse inventory file re-run
 * with "Overwrite" and no match field created every row again (16k duplicates); its rows are
 * only unique on warehouse + CIFA together.
 *
 * The fields live in nivaro_import_jobs.id_field / nivaro_import_mappings.id_field (no
 * migration): one name stays a plain name ("code"), several are a comma list
 * ("warehouse,cifa"); a JSON array is read too. Matching compares the RESOLVED values (an M2O
 * cell's record id after the link resolver), every field must be equal, null-safe (a blank cell
 * matches a blank column, see MatchKind). A row whose match fields are all empty cannot match: it is created.
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

/**
 * How a match field's values compare — the same rule in the run, the preview and row repair,
 * written to agree with SQL Server's `=` under the database's default case-insensitive,
 * accent-sensitive collation:
 *
 *   text    trailing spaces ignored (ANSI padding), case-insensitive; '' and NULL are the same
 *           "blank" (the importer writes '' for a blank text cell — a blank cell finds both)
 *   number  compared as numbers ("12" = 12 = "12.0") — numeric field types only
 *   id      a link's resolved record id or the primary key: its text, case-insensitive (uuids)
 *   bool    yes/no as 1/0
 *   date    by instant
 */
export type MatchKind = 'text' | 'number' | 'id' | 'bool' | 'date'

const NUMERIC_KINDS = new Set([
  'integer',
  'biginteger',
  'bigint',
  'int',
  'smallint',
  'tinyint',
  'smallinteger',
  'tinyinteger',
  'decimal',
  'float',
  'double',
  'numeric',
  'real',
  'money',
  'currency'
])

/** A match field's kind from its field type; links and the primary key compare as ids. */
export function matchKindOf(
  field: string,
  type: string | null | undefined,
  isLink: boolean
): MatchKind {
  if (isLink || field === 'id') return 'id'
  const t = String(type ?? '').toLowerCase()
  if (NUMERIC_KINDS.has(t)) return 'number'
  if (t === 'boolean' || t === 'bool' || t === 'bit') return 'bool'
  if (t === 'date' || t === 'datetime' || t === 'timestamp' || t === 'datetime2') return 'date'
  return 'text'
}

/** One cell's comparison key under its kind; null = blank (no value). */
export function matchCellKey(v: unknown, kind: MatchKind): string | null {
  if (v == null) return null
  if (kind === 'text') {
    const s = String(v).replace(/\s+$/, '')
    return s === '' ? null : `s:${s.toLowerCase()}`
  }
  if (typeof v === 'string' && v.trim() === '') return null
  if (kind === 'number') {
    const n = typeof v === 'number' ? v : Number(String(v).trim())
    return Number.isFinite(n) ? `n:${n}` : `s:${String(v).trim().toLowerCase()}`
  }
  if (kind === 'bool') {
    const t = String(v).trim().toLowerCase()
    if (v === true || t === '1' || t === 'true') return 'b:1'
    if (v === false || t === '0' || t === 'false') return 'b:0'
    return `s:${t}`
  }
  if (kind === 'date') {
    const d = v instanceof Date ? v : new Date(String(v))
    return Number.isNaN(d.getTime()) ? `s:${String(v).trim()}` : `d:${d.getTime()}`
  }
  return `i:${String(v).trim().toLowerCase()}`
}

/** The key a row (or a record) has on the match fields — equal keys = the same record. */
export function matchKeyOf(values: unknown[], kinds: MatchKind[]): string {
  return JSON.stringify(values.map((v, i) => matchCellKey(v, kinds[i] ?? 'text')))
}

/** Can the row match at all? Not when every match field is blank (it is then created). */
export function matchUsable(values: unknown[], kinds: MatchKind[]): boolean {
  return values.some((v, i) => matchCellKey(v, kinds[i] ?? 'text') != null)
}

/**
 * Refuse a job before it is stored (POST /imports, /from-url) or run: every match field must be
 * mapped from a column of the file (an unmapped one reads as blank on every row — every row
 * created, or matched on "blank"), and Overwrite / Merge with no match field at all only with an
 * explicit `confirm_no_match` (it creates every row: EFP prod 2026-11-19, 16k duplicates).
 */
export function matchSetupProblem(opts: {
  matchFields: string[]
  columnMap: Record<string, string> | null | undefined
  strategy: string | null | undefined
  confirmNoMatch?: boolean
}): { code: 'MATCH_FIELD_NOT_MAPPED' | 'NO_MATCH_FIELDS'; error: string } | null {
  const mapped = new Set(Object.values(opts.columnMap ?? {}).filter(Boolean))
  const missing = opts.matchFields.filter((f) => !mapped.has(f))
  if (missing.length > 0)
    return {
      code: 'MATCH_FIELD_NOT_MAPPED',
      error: `${missing.join(', ')} ${missing.length === 1 ? 'is a match field but no column of the file is' : 'are match fields but no column of the file is'} mapped to ${missing.length === 1 ? 'it' : 'them'} — map a column, or stop matching on ${missing.length === 1 ? 'it' : 'them'}`
    }
  const strategy = String(opts.strategy ?? 'skip')
  if (
    opts.matchFields.length === 0 &&
    (strategy === 'overwrite' || strategy === 'merge') &&
    opts.confirmNoMatch !== true
  )
    return {
      code: 'NO_MATCH_FIELDS',
      error:
        'No match fields: every row will be created as a new record, so nothing can be overwritten or merged. Pick the fields that identify a record, or send confirm_no_match: true to create every row.'
    }
  return null
}

/** "Warehouse 'Main' and CIFA '1234'" — the match fields as a person reads them. */
export function describeMatch(
  fields: string[],
  shown: Record<string, unknown>,
  labelOf: (field: string) => string
): string {
  const parts = fields.map((f) => {
    const v = shown[f]
    return v == null || String(v).trim() === ''
      ? `${labelOf(f)} empty`
      : `${labelOf(f)} '${String(v).trim().slice(0, 60)}'`
  })
  return parts.length <= 1
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** The row error for a row two or more existing records match. */
export function ambiguousMatchText(described: string): string {
  return `More than one existing record matches ${described} — the import cannot tell which one to update. Add a match field that tells them apart, or remove the duplicates first.`
}
