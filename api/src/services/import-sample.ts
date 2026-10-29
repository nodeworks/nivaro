import { db } from '../db/index.js'
import { parseValidationConfig } from './staged-import-validation.js'

// A sample CSV for one staged import definition (Import Console → Download sample): the
// headers the import reads, in its order, and a few rows showing how to fill them in. Rows
// come from the import's own staging table when a recent run left any (exactly what a real
// file looked like); otherwise they are generated — real values from each lookup collection
// (a warehouse name, a CIFA number), numbers for numeric columns, today for dates.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const SAMPLE_ROWS = 3
// Bookkeeping columns staging tables carry that no file ever supplies.
const SKIP_COLUMNS = new Set(['id', 'import_id', 'import_run_id', 'row_number', 'created_at'])

export interface SampleColumn {
  /** Staging column. */
  name: string
  /** Header the file carries for it. */
  header: string
  type?: string
  required?: boolean
}

export interface ImportSample {
  filename: string
  csv: string
  /** Where the rows came from. */
  source: 'staging' | 'generated' | 'headers'
  columns: SampleColumn[]
}

type DefinitionLike = {
  key: string
  staging_table: string | null
  staging_columns: unknown
  validation: unknown
}

/** Declared columns (objects or bare names), else the staging table's own columns. */
export async function sampleColumns(def: DefinitionLike): Promise<SampleColumn[]> {
  const raw =
    typeof def.staging_columns === 'string' ? safeJson(def.staging_columns) : def.staging_columns
  if (Array.isArray(raw) && raw.length > 0) {
    const out: SampleColumn[] = []
    for (const c of raw) {
      if (typeof c === 'string') {
        if (IDENT.test(c)) out.push({ name: c, header: c })
        continue
      }
      if (!c || typeof c !== 'object') continue
      const o = c as { name?: unknown; from_header?: unknown; type?: unknown; required?: unknown }
      const name = String(o.name ?? '').trim()
      if (!IDENT.test(name)) continue
      const header =
        typeof o.from_header === 'string' && o.from_header.trim() ? o.from_header : name
      out.push({
        name,
        header,
        type: typeof o.type === 'string' ? o.type : undefined,
        required: o.required === true
      })
    }
    if (out.length > 0) return out
  }
  if (!def.staging_table || !IDENT.test(def.staging_table)) return []
  const cols = (await db.raw(
    'SELECT c.name AS name, t.name AS type FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id WHERE c.object_id = OBJECT_ID(?) ORDER BY c.column_id',
    [def.staging_table]
  )) as Array<{ name: string; type: string }>
  return cols
    .filter((c) => !SKIP_COLUMNS.has(c.name.toLowerCase()))
    .map((c) => ({ name: c.name, header: c.name, type: sqlTypeKind(c.type) }))
}

export async function buildImportSample(def: DefinitionLike): Promise<ImportSample> {
  const columns = await sampleColumns(def)
  const filename = `${def.key.replace(/[^A-Za-z0-9_-]+/g, '_')}_sample.csv`
  if (columns.length === 0) return { filename, csv: '', source: 'headers', columns }

  let rows = await stagingRows(def.staging_table, columns)
  let source: ImportSample['source'] = 'staging'
  if (rows.length === 0) {
    rows = await generatedRows(def, columns)
    source = 'generated'
  }
  const lines = [
    columns.map((c) => csvCell(c.header)).join(','),
    ...rows.map((r) => columns.map((c) => csvCell(r[c.name] ?? '')).join(','))
  ]
  return { filename, csv: `${lines.join('\r\n')}\r\n`, source, columns }
}

/** Up to SAMPLE_ROWS rows a recent run left in the staging table (only non-empty ones). */
async function stagingRows(
  table: string | null,
  columns: SampleColumn[]
): Promise<Array<Record<string, string>>> {
  if (!table || !IDENT.test(table)) return []
  try {
    const present = new Set(
      (
        (await db.raw('SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(?)', [
          table
        ])) as Array<{ name: string }>
      ).map((c) => c.name.toLowerCase())
    )
    const cols = columns.filter((c) => present.has(c.name.toLowerCase()))
    if (cols.length === 0) return []
    const rows = (await db(table)
      .select(cols.map((c) => c.name))
      .limit(SAMPLE_ROWS * 4)) as Array<Record<string, unknown>>
    return rows
      .map((r) => {
        const o: Record<string, string> = {}
        for (const c of cols) o[c.name] = cellText(r[c.name])
        return o
      })
      .filter((r) => Object.values(r).some((v) => v !== ''))
      .slice(0, SAMPLE_ROWS)
  } catch {
    return []
  }
}

async function generatedRows(
  def: DefinitionLike,
  columns: SampleColumn[]
): Promise<Array<Record<string, string>>> {
  const v = parseValidationConfig(def.validation)
  const numeric = new Set((v?.numeric ?? []).map((n) => n.toLowerCase()))
  const lookupFor = new Map<string, { collection: string; match_field: string }>()
  for (const l of v?.lookups ?? []) lookupFor.set(String(l.column).toLowerCase(), l)
  const today = new Date()
  const iso = today.toISOString().slice(0, 10)
  const out: Array<Record<string, string>> = Array.from({ length: SAMPLE_ROWS }, () => ({}))
  for (const c of columns) {
    const lk = lookupFor.get(c.header.toLowerCase()) ?? lookupFor.get(c.name.toLowerCase())
    const real = lk ? await lookupValues(lk.collection, lk.match_field) : []
    const n = c.name.toLowerCase()
    for (let i = 0; i < SAMPLE_ROWS; i++) {
      let cell: string
      if (real.length > 0) cell = real[i % real.length]
      else if (n === 'year' || n.endsWith('_year')) cell = String(today.getFullYear())
      else if (n === 'month' || n.endsWith('_month')) cell = String(today.getMonth() + 1)
      else if (c.type === 'date' || /(^|_)(date|day)$|_at$/.test(n)) cell = iso
      else if (
        numeric.has(n) ||
        numeric.has(c.header.toLowerCase()) ||
        c.type === 'int' ||
        c.type === 'decimal' ||
        /(qty|quantity|amount|price|cost|count|total|usage)/.test(n)
      )
        cell =
          c.type === 'decimal' || /(price|cost|amount)/.test(n)
            ? ['12.50', '3.75', '100.00'][i]
            : ['1', '10', '25'][i]
      else if (lk) cell = `${c.header} ${i + 1}`
      else cell = `Example ${c.header.replace(/_/g, ' ')} ${i + 1}`
      out[i][c.name] = cell
    }
  }
  return out
}

/** A few real values of a lookup's match field (what the import joins on). */
async function lookupValues(collection: string, field: string): Promise<string[]> {
  if (!IDENT.test(collection) || !IDENT.test(field)) return []
  if (/^(nivaro|directus)_/i.test(collection)) return []
  try {
    const rows = (await db(collection)
      .whereNotNull(field)
      .select(field)
      .limit(SAMPLE_ROWS * 4)) as Array<Record<string, unknown>>
    return [...new Set(rows.map((r) => cellText(r[field])).filter(Boolean))].slice(0, SAMPLE_ROWS)
  } catch {
    return []
  }
}

function sqlTypeKind(t: string): string | undefined {
  const s = t.toLowerCase()
  if (/int/.test(s)) return 'int'
  if (/decimal|numeric|money|float|real/.test(s)) return 'decimal'
  if (/date|time/.test(s)) return 'date'
  return undefined
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v)
}

/** RFC 4180 cell; a leading = + - @ is prefixed so a spreadsheet never runs it as a formula. */
export function csvCell(v: string): string {
  let s = v
  if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
