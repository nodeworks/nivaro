import { db } from '../db/index.js'

/**
 * Pre-flight validation for staged imports — runs against the PARSED FILE and
 * the TARGET business tables, never the staging table (whose shape is a
 * consequence of the import, may not exist yet, and may change).
 *
 * Failure posture: the two config-driven check groups fail OPEN with a loud
 * warning — a typo'd validation config or a renamed lookup column must never
 * brick the import pipeline. Hard errors come only from checks computed from
 * the file itself against the DECLARED schema (missing required column,
 * duplicate keys), which cannot rot.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Rows scanned by per-row checks; beyond this the report flags truncation. */
const SCAN_CAP = 20_000
/** Distinct keys/values fetched per target/lookup check. */
const KEY_CAP = 20_000
const CHUNK = 500

export interface StagingColumnDef {
  /** Staging column name (plain identifier). */
  name: string
  type?: 'text' | 'decimal' | 'int' | 'date'
  /** Sheet header this column is filled from; defaults to `name`. */
  from_header?: string
  required?: boolean
}

export interface ImportValidationConfig {
  /** File columns forming a row's identity — duplicates within the file are
   *  flagged (last-write-wins ambiguity inside one run). */
  key_columns?: string[]
  /** Business table the procedure ultimately writes, for new/update counts. */
  target_table?: string
  /** file column -> target column (single or composite key). */
  target_match?: Record<string, string>
  /* Row numbers in issues are SPREADSHEET rows (header = row 1, first data
   row = 2) so they match what the user sees opening the file. */
/** Join-miss detection: rows whose value matches nothing the procedure can
   *  join to (the rows it would silently drop or NULL-out). */
  lookups?: Array<{ column: string; collection: string; match_field: string; label?: string }>
  required?: string[]
  numeric?: string[]
}

export interface ValidationIssue {
  code: string
  message: string
  /** 1-based data-row numbers (matching the sheet minus its header). */
  rows?: number[]
  count?: number
}

export interface ValidationReport {
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
  stats: Record<string, number | boolean | null>
  /** Row scan hit SCAN_CAP — counts below describe the scanned prefix. */
  truncated: boolean
}

export function parseStagingColumns(raw: unknown): StagingColumnDef[] | null {
  const parsed = typeof raw === 'string' ? safeJson(raw) : raw
  if (!Array.isArray(parsed)) return null
  const out: StagingColumnDef[] = []
  for (const c of parsed) {
    if (!c || typeof c !== 'object') continue
    const name = String((c as StagingColumnDef).name ?? '').trim()
    if (!IDENT.test(name)) continue
    out.push({
      name,
      type: (c as StagingColumnDef).type,
      from_header: (c as StagingColumnDef).from_header,
      required: (c as StagingColumnDef).required === true
    })
  }
  return out.length > 0 ? out : null
}

export function parseValidationConfig(raw: unknown): ImportValidationConfig | null {
  const parsed = typeof raw === 'string' ? safeJson(raw) : raw
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed as ImportValidationConfig
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

export function normalizeHeader(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * Resolve which parsed-file header feeds each declared column. The same
 * punctuation-tolerant matching the loaders use, so what validates is what
 * loads: exact (case-insensitive) first, then squashed.
 */
export function resolveHeaderMap(
  fileColumns: string[],
  declared: StagingColumnDef[]
): { headerFor: Map<string, string>; missing: StagingColumnDef[]; unknownHeaders: string[] } {
  const byLower = new Map(fileColumns.map((c) => [c.toLowerCase(), c]))
  const byNorm = new Map(fileColumns.map((c) => [normalizeHeader(c), c]))
  const headerFor = new Map<string, string>()
  const missing: StagingColumnDef[] = []
  for (const col of declared) {
    const want = col.from_header ?? col.name
    const hit = byLower.get(want.toLowerCase()) ?? byNorm.get(normalizeHeader(want))
    if (hit) headerFor.set(col.name, hit)
    else missing.push(col)
  }
  const claimed = new Set(headerFor.values())
  const unknownHeaders = fileColumns.filter((c) => !claimed.has(c))
  return { headerFor, missing, unknownHeaders }
}

/** A cleaned cell counts as empty when it is '' after the cleaner ran. */
const isEmpty = (v: string | undefined) => v == null || v === ''

const isNumericValue = (v: string) => {
  const n = Number(v)
  return Number.isFinite(n)
}

function sample(nums: number[], cap = 10): number[] {
  return nums.slice(0, cap)
}

export async function validateStagedRows(
  definition: {
    staging_columns?: unknown
    validation?: unknown
  },
  rows: Array<Record<string, string>>
): Promise<ValidationReport> {
  const report: ValidationReport = { errors: [], warnings: [], stats: {}, truncated: false }
  const declared = parseStagingColumns(definition.staging_columns)
  const cfg = parseValidationConfig(definition.validation)
  if (!declared && !cfg) return report

  const scan = rows.length > SCAN_CAP ? rows.slice(0, SCAN_CAP) : rows
  report.truncated = rows.length > SCAN_CAP
  const fileColumns = [...new Set(scan.flatMap((r) => Object.keys(r)))]

  // Value lookup that honors the declared header mapping when present, so a
  // config naming `base_invoice` finds the "Base Invoice" header.
  let headerFor: Map<string, string> | null = null
  if (declared) {
    const resolved = resolveHeaderMap(fileColumns, declared)
    headerFor = resolved.headerFor
    const missingRequired = resolved.missing.filter((c) => c.required)
    const missingOptional = resolved.missing.filter((c) => !c.required)
    if (missingRequired.length > 0) {
      report.errors.push({
        code: 'missing_columns',
        message: `The file has no column for: ${missingRequired.map((c) => c.from_header ?? c.name).join(', ')} — the procedure reads them.`
      })
    }
    if (missingOptional.length > 0) {
      report.warnings.push({
        code: 'missing_optional_columns',
        message: `Columns declared but absent from this file (will load empty): ${missingOptional.map((c) => c.from_header ?? c.name).join(', ')}`
      })
    }
    if (resolved.unknownHeaders.length > 0) {
      report.warnings.push({
        code: 'unknown_columns',
        message: `File columns not in the declared schema (ignored by the procedure): ${resolved.unknownHeaders.join(', ')}`
      })
    }
  }
  const byLowerFile = new Map(fileColumns.map((c) => [c.toLowerCase(), c]))
  const byNormFile = new Map(fileColumns.map((c) => [normalizeHeader(c), c]))
  const headerOf = (col: string): string | null =>
    headerFor?.get(col) ??
    byLowerFile.get(col.toLowerCase()) ??
    byNormFile.get(normalizeHeader(col)) ??
    null
  const valueOf = (row: Record<string, string>, col: string): string | undefined => {
    const h = headerOf(col)
    return h ? row[h] : undefined
  }

  // ── Per-row checks (file-derived — these can hard-error) ──────────────────
  const requiredCols = [
    ...new Set([...(cfg?.required ?? []), ...(declared?.filter((c) => c.required).map((c) => c.name) ?? [])])
  ]
  for (const col of requiredCols) {
    if (!headerOf(col)) continue // column absence already reported above
    const bad: number[] = []
    scan.forEach((r, i) => {
      if (isEmpty(valueOf(r, col))) bad.push(i + 2)
    })
    if (bad.length > 0) {
      report.errors.push({
        code: 'required_empty',
        message: `${bad.length} row(s) have an empty ${col}`,
        rows: sample(bad),
        count: bad.length
      })
    }
  }

  const numericCols = [
    ...new Set([
      ...(cfg?.numeric ?? []),
      ...(declared?.filter((c) => c.type === 'decimal' || c.type === 'int').map((c) => c.name) ?? [])
    ])
  ]
  for (const col of numericCols) {
    if (!headerOf(col)) continue
    const bad: number[] = []
    scan.forEach((r, i) => {
      const v = valueOf(r, col)
      if (!isEmpty(v) && !isNumericValue(v as string)) bad.push(i + 2)
    })
    if (bad.length > 0) {
      report.errors.push({
        code: 'not_numeric',
        message: `${bad.length} row(s) have a non-numeric ${col}`,
        rows: sample(bad),
        count: bad.length
      })
    }
  }

  // ── Duplicate keys within the file ────────────────────────────────────────
  const keyCols = (cfg?.key_columns ?? []).filter((c) => headerOf(c))
  let keyOf: ((r: Record<string, string>) => string) | null = null
  if (keyCols.length > 0) {
    keyOf = (r) => keyCols.map((c) => (valueOf(r, c) ?? '').trim().toLowerCase()).join('\u0001')
    const seen = new Map<string, number>()
    const dupRows: number[] = []
    scan.forEach((r, i) => {
      const k = keyOf?.(r) as string
      if (k.replace(/\u0001/g, '') === '') return // blank keys reported by required checks
      if (seen.has(k)) dupRows.push(i + 2)
      else seen.set(k, i + 2)
    })
    if (dupRows.length > 0) {
      report.errors.push({
        code: 'duplicate_keys',
        message: `${dupRows.length} row(s) repeat an earlier row's ${keyCols.join(' + ')} — within one file the last occurrence silently wins`,
        rows: sample(dupRows),
        count: dupRows.length
      })
    }
    report.stats.distinct_keys = seen.size
  }

  // ── Config-driven checks against live tables (fail OPEN) ──────────────────
  try {
    if (cfg?.target_table && cfg.target_match && Object.keys(cfg.target_match).length > 0) {
      await targetDiff(cfg, scan, valueOf, report)
    }
  } catch (err) {
    report.warnings.push({
      code: 'target_check_failed',
      message: `New/update counts could not be computed: ${(err as Error).message}`
    })
  }
  for (const lookup of cfg?.lookups ?? []) {
    try {
      await lookupMisses(lookup, scan, valueOf, report)
    } catch (err) {
      report.warnings.push({
        code: 'lookup_check_failed',
        message: `Lookup check for ${lookup.column} could not run: ${(err as Error).message}`
      })
    }
  }

  return report
}

async function targetDiff(
  cfg: ImportValidationConfig,
  scan: Array<Record<string, string>>,
  valueOf: (row: Record<string, string>, col: string) => string | undefined,
  report: ValidationReport
): Promise<void> {
  const table = String(cfg.target_table)
  if (!IDENT.test(table) || /^nivaro_/i.test(table)) {
    throw new Error(`target_table "${table}" is not an allowed table`)
  }
  const entries = Object.entries(cfg.target_match ?? {})
  for (const [, targetCol] of entries) {
    if (!IDENT.test(targetCol)) throw new Error(`Unsafe target column "${targetCol}"`)
  }

  // Composite keys compare as a joined tuple fetched per first column's chunk.
  const fileKey = (r: Record<string, string>) =>
    entries.map(([fileCol]) => (valueOf(r, fileCol) ?? '').trim().toLowerCase()).join('\u0001')

  const keys = new Map<string, string[]>() // tuple -> first-column raw values
  for (const r of scan) {
    const k = fileKey(r)
    if (k.replace(/\u0001/g, '') === '') continue
    if (!keys.has(k)) keys.set(k, entries.map(([fileCol]) => (valueOf(r, fileCol) ?? '').trim()))
    if (keys.size >= KEY_CAP) break
  }
  if (keys.size === 0) return

  // Fetch existing tuples by chunking on the FIRST match column, then compare
  // full tuples in JS — one round trip per 500 first-column values.
  const firstFileCol = entries[0][0]
  const firstTargetCol = entries[0][1]
  const firstValues = [...new Set([...keys.values()].map((t) => t[0]))]
  const existing = new Set<string>()
  for (let i = 0; i < firstValues.length; i += CHUNK) {
    const chunk = firstValues.slice(i, i + CHUNK)
    const rows = (await db(table)
      .whereIn(firstTargetCol, chunk)
      .select(entries.map(([, t]) => t))) as Array<Record<string, unknown>>
    for (const row of rows) {
      existing.add(
        entries.map(([, t]) => String(row[t] ?? '').trim().toLowerCase()).join('\u0001')
      )
    }
  }

  let updates = 0
  for (const k of keys.keys()) if (existing.has(k)) updates++
  report.stats.existing_rows = updates
  report.stats.new_rows = keys.size - updates
  report.stats.match_columns = entries.length
  void firstFileCol
}

async function lookupMisses(
  lookup: { column: string; collection: string; match_field: string; label?: string },
  scan: Array<Record<string, string>>,
  valueOf: (row: Record<string, string>, col: string) => string | undefined,
  report: ValidationReport
): Promise<void> {
  const { column, collection, match_field } = lookup
  if (!IDENT.test(collection) || /^nivaro_/i.test(collection)) {
    throw new Error(`collection "${collection}" is not an allowed table`)
  }
  if (!IDENT.test(match_field)) throw new Error(`Unsafe match_field "${match_field}"`)

  const values = new Map<string, string>() // lowered -> raw
  for (const r of scan) {
    const v = valueOf(r, column)
    if (!isEmpty(v)) values.set((v as string).trim().toLowerCase(), (v as string).trim())
    if (values.size >= KEY_CAP) break
  }
  if (values.size === 0) return

  const found = new Set<string>()
  const raws = [...values.values()]
  for (let i = 0; i < raws.length; i += CHUNK) {
    const chunk = raws.slice(i, i + CHUNK)
    const rows = (await db(collection).whereIn(match_field, chunk).pluck(match_field)) as unknown[]
    for (const v of rows) found.add(String(v).trim().toLowerCase())
  }

  const misses = [...values.entries()].filter(([low]) => !found.has(low)).map(([, raw]) => raw)
  if (misses.length > 0) {
    // Rows carrying a missed value, for the report's row pointers.
    const missSet = new Set(misses.map((m) => m.toLowerCase()))
    const badRows: number[] = []
    scan.forEach((r, i) => {
      const v = valueOf(r, column)
      if (!isEmpty(v) && missSet.has((v as string).trim().toLowerCase())) badRows.push(i + 2)
    })
    report.warnings.push({
      code: 'lookup_miss',
      message: `${badRows.length} row(s) have a ${lookup.label ?? column} matching nothing in ${collection}.${match_field}: ${misses.slice(0, 8).join(', ')}${misses.length > 8 ? ` (+${misses.length - 8} more)` : ''}`,
      rows: sample(badRows),
      count: badRows.length
    })
  }
}
