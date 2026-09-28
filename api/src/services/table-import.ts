import { Parser } from 'expr-eval'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import {
  type BatchOutcome,
  batchCreate,
  batchDelete,
  batchRefusal,
  batchUpdate,
  columnTypes
} from './batch-writes.js'
import type {
  ImportRunChange,
  ImportRunItem,
  ImportRunPhase,
  ImportRunUnmatched
} from './import-run-report.js'
import { createOne, deleteOne, updateOne } from './items.js'
import { getLabels } from './queues.js'
import { runLongSql } from './run-long.js'
import type {
  ServiceColumnConfig,
  ServiceImportConfig,
  ServiceImportSamples
} from './staged-import-service.js'

/**
 * Table import — a file whose rows each describe ONE record of ONE
 * collection, plus the sets of other records each is linked to.
 *
 * Everything about an import is configuration on its definition. A run
 *
 *   1. resolves the reference columns of the file (a name → the id it names),
 *      once per column, and lists every value that names nothing
 *   2. builds one record per file row, keeps the LAST row of a repeated key
 *   3. reads the stored records the file names and compares field by field
 *   4. writes only what differs: through the items service, or set-based with
 *      per-record history when the run changes more records than that serves
 *   5. brings each record's links to the set the file names
 *   6. runs the procedures that follow from the rows, once
 *
 * and reports every step: what was created and changed (each field before and
 * after), what was left out and why, which values matched nothing, which keys
 * the collection already holds more than once.
 */

/** A value a lookup is narrowed by: a file column as written, or a file
 *  column that itself names a record (the id of that record is compared). */
export type TableScopeValue =
  | string
  | { column: string; lookup: { collection: string; match_field: string } }

export interface TableLookup {
  collection: string
  match_field?: string
  match_label?: boolean
  /** `match_field` holds a reference, not text: the file value is first
   *  resolved through this lookup and the id is what is compared — a
   *  composite key like categories (core category, sub category) is then
   *  `match_field: 'core_category'` + `match_lookup` + a `scope` entry
   *  with its own lookup. */
  match_lookup?: { collection: string; match_field: string }
  /** Legacy spelling of `unmatched`. */
  on_missing?: 'create' | 'null'
  /** More columns of the lookup row that must agree with the file row:
   *  lookup column → where the value comes from. */
  scope?: Record<string, TableScopeValue>
  /** Fields set on the record when this lookup is the one that matched. */
  then?: Record<string, string | number | boolean | null>
  /** Where to look when nothing matches here. */
  fallback?: {
    collection: string
    match_field: string
    then?: Record<string, string | number | boolean | null>
  }
  /** Written on a record created for an unmatched value: lookup column →
   *  file column. */
  create_with?: Record<string, string>
  /** A value that names several records: use the first (lowest id), or
   *  treat it as naming nothing. */
  ambiguous?: 'first' | 'unmatched'
}

export interface TableColumn extends Omit<ServiceColumnConfig, 'lookup'> {
  /** The file column read; the entry's own name when absent. Lets two fields
   *  read one column. */
  from?: string
  lookup?: TableLookup
  /** A value that names nothing: drop the row | store nothing | keep what the
   *  record holds | create the named record. */
  unmatched?: 'drop' | 'null' | 'keep' | 'create'
  /** An empty cell: clear the field (default) or keep what the record holds. */
  blank?: 'clear' | 'keep'
  /** File value → stored value, matched without regard to case. */
  map?: Record<string, string | number | boolean | null>
  /** Stored when a non-empty cell matches no `map` entry (absent: the cell
   *  is read as the field's own kind). */
  map_else?: string | number | boolean | null
  /** Stored when the cell is empty. */
  default?: string | number | boolean | null
  case?: 'upper' | 'lower'
  /** Rows of the file that share a key add their values up. */
  aggregate?: 'sum'
}

export type TableAfterStep =
  | string
  | {
      procedure: string
      /** Parameter name → a fixed value, or `$touched.<field>`: the distinct
       *  values of that field over the records the run wrote, comma-joined.
       *  The object form goes one record further: the distinct `column` of
       *  the `collection` records that field names. A step whose list is
       *  empty is not run. */
      args?: Record<
        string,
        string | number | { touched: string; collection: string; column: string }
      >
    }

export interface TableLink {
  /** File column holding the values (absent when `via` derives them). */
  column?: string
  /** The related ids are a column of the records ANOTHER link resolved
   *  (`{link: 'regions', column: 'division'}`: the zones of the regions the
   *  row named), never read from the file. */
  via?: { link: string; column: string }
  separator?: string
  junction: string
  parent_field: string
  related_field: string
  /** How a value names the related record; absent = the value is the id. */
  lookup?: { collection: string; match_field: string; ambiguous?: 'first' | 'unmatched' }
  /** replace: the record ends with exactly the file's set. add: only adds. */
  mode?: 'replace' | 'add'
  /** The file carries ONE link per row: rows that repeat a record's key each
   *  add a value to its set instead of replacing the row before. */
  per_row?: boolean
}

export interface TableImportConfig extends Omit<ServiceImportConfig, 'columns'> {
  columns: Record<string, TableColumn>
  /** Target field → expression over the record's fields. */
  compute?: Record<string, string>
  /** Constants written on every created record. */
  set?: Record<string, string | number | boolean | null>
  /** Constants written on every stored record the file names. */
  set_on_update?: Record<string, string | number | boolean | null>
  /** Only stored records with these values are the file's records; a
   *  created record gets them. */
  where?: Record<string, string | number | boolean | null>
  /** Several tables filled from one file, in order. Each step is a whole
   *  configuration; the outer one then needs no collection of its own. */
  steps?: TableImportConfig[]
  links?: Record<string, TableLink>
  /** Never update a stored record. */
  create_only?: boolean
  /** Key fields that may be empty; an empty value matches an empty value. */
  match_optional?: string[]
  /** Stored records that share a key: write the first (lowest id), write
   *  all, or leave the file row out and say which records it names. */
  duplicates?: 'first' | 'all' | 'refuse'
  write?: {
    mode?: 'auto' | 'items' | 'batch'
    /** auto: more writes than this go set-based. */
    batch_over?: number
    width?: number
  }
  /** Procedures run once after the rows have landed. */
  after?: TableAfterStep[]
  /** Load the staging table as well (a procedure in `after` reads it). */
  keep_staging?: boolean
  /** What one record is called in the report ('unit', 'invoice line'). */
  noun?: string
  /** Field shown as the record's name in the report. */
  label_field?: string
}

export interface TableImportResult {
  created: number
  updated: number
  unchanged: number
  skipped: Record<string, number>
  failed: number
  log: string
  samples?: ServiceImportSamples
  affected: Record<string, Array<string | number>>
  /** Every stored record the file named, changed or not. */
  matched: Record<string, Array<string | number>>
  report: {
    phases: ImportRunPhase[]
    unmatched: ImportRunUnmatched[]
    notes: string[]
    other: Array<{ label: string; count: number }>
  }
  items: ImportRunItem[]
}

export interface RunTableImportOptions {
  config: TableImportConfig
  rows: Array<Record<string, string>>
  createdBy: string | null
  onProgress?: (done: number, total: number) => void | Promise<void>
  dryRun?: boolean
  sampleLimit?: number
  stamp?: string | null
  /** Dry run of a `steps` import: the records the earlier steps would have
   *  created, per collection, so a later step's lookup can name them
   *  instead of reporting no match. */
  dryCreated?: Map<string, Array<Record<string, unknown>>>
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const CHUNK = 500
const DEFAULT_BATCH_OVER = 500
const ITEM_CAP = 50_000
const VALUE_SAMPLE = 50

const parser = new Parser()

export function parseTableConfig(raw: unknown): TableImportConfig | null {
  if (!raw) return null
  try {
    const cfg = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!cfg || typeof cfg !== 'object') return null
    const c = cfg as TableImportConfig
    if (Array.isArray(c.steps) && c.steps.length > 0) {
      const steps = c.steps.map((st) => parseTableConfig(st))
      if (steps.some((st) => !st || st.steps)) return null
      const first = steps[0] as TableImportConfig
      return {
        ...first,
        ...c,
        collection: c.collection ?? first.collection,
        steps: steps as TableImportConfig[],
        match_by: c.match_by ?? first.match_by,
        columns: c.columns ?? first.columns
      }
    }
    if (!c.collection || !IDENT.test(c.collection) || /^nivaro_/i.test(c.collection)) return null
    if (!Array.isArray(c.match_by) || c.match_by.some((f) => !IDENT.test(f))) return null
    if (!c.columns || typeof c.columns !== 'object') return null
    for (const cc of Object.values(c.columns)) {
      if (!cc?.field || !IDENT.test(cc.field)) return null
      if (cc.lookup && !IDENT.test(cc.lookup.collection)) return null
      const ml = cc.lookup?.match_lookup
      if (ml && !(IDENT.test(ml.collection) && IDENT.test(ml.match_field))) return null
    }
    for (const [name, l] of Object.entries(c.links ?? {})) {
      if (![l.junction, l.parent_field, l.related_field].every((v) => IDENT.test(String(v))))
        return null
      if (l.via) {
        const source = c.links?.[l.via.link]
        if (!source || source === l || source.via || !source.lookup) return null
        if (!IDENT.test(l.via.column)) return null
      } else if (!l.column) return null
      if (name === l.via?.link) return null
    }
    for (const step of c.after ?? []) {
      const name = typeof step === 'string' ? step : step?.procedure
      if (!name || !IDENT.test(name)) return null
      if (typeof step !== 'string') {
        for (const [arg, v] of Object.entries(step.args ?? {})) {
          if (!IDENT.test(arg)) return null
          if (typeof v === 'string' && v.startsWith('$touched.') && !IDENT.test(v.slice(9))) {
            return null
          }
          if (v && typeof v === 'object') {
            if (![v.touched, v.collection, v.column].every((x) => IDENT.test(String(x))))
              return null
          }
        }
      }
    }
    for (const f of c.match_optional ?? []) if (!c.match_by.includes(f)) return null
    return c
  } catch {
    return null
  }
}

// ─── values ─────────────────────────────────────────────────────────────────

type Kind = 'int' | 'number' | 'boolean' | 'date' | 'datetime' | 'string'

function kindOf(sql: string | undefined, declared: TableColumn['type']): Kind {
  if (declared) return declared
  const t = String(sql ?? '').toLowerCase()
  if (/^(int|bigint|smallint|tinyint)\b/.test(t)) return 'int'
  if (/^(decimal|numeric|float|real|money|smallmoney)\b/.test(t)) return 'number'
  if (t === 'bit') return 'boolean'
  if (t === 'date') return 'date'
  if (/^(datetime|datetime2|smalldatetime|datetimeoffset)\b/.test(t)) return 'datetime'
  return 'string'
}

const pad = (n: number) => String(n).padStart(2, '0')

/** A select list without repeats: a lookup on the id itself names it once. */
const cols = (...names: string[]) => [...new Set(names)]

/** A date as people and spreadsheets write it. Null when it is not a date. */
export function readDate(text: string): Date | null {
  const v = text.trim()
  if (!v) return null
  // a spreadsheet's day count
  if (/^\d{5}(\.\d+)?$/.test(v)) {
    const days = Number(v)
    if (days > 20000 && days < 80000) return new Date(Math.round((days - 25569) * 86400000))
  }
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(v)
  if (iso) {
    const d = new Date(
      Date.UTC(+iso[1], +iso[2] - 1, +iso[3], +(iso[4] ?? 0), +(iso[5] ?? 0), +(iso[6] ?? 0))
    )
    return Number.isNaN(d.getTime()) ? null : d
  }
  const us =
    /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(
      v
    )
  if (us) {
    let year = +us[3]
    if (year < 100) year += year < 70 ? 2000 : 1900
    let hour = +(us[4] ?? 0)
    if (us[7]) {
      const pm = us[7].toLowerCase() === 'pm'
      if (pm && hour < 12) hour += 12
      if (!pm && hour === 12) hour = 0
    }
    const month = +us[1]
    const day = +us[2]
    if (month < 1 || month > 12 || day < 1 || day > 31) return null
    const d = new Date(Date.UTC(year, month - 1, day, hour, +(us[5] ?? 0), +(us[6] ?? 0)))
    return d.getUTCMonth() === month - 1 ? d : null
  }
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return null
  return new Date(
    Date.UTC(
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
      d.getHours(),
      d.getMinutes(),
      d.getSeconds()
    )
  )
}

/** A cell as the value the column stores; `bad` when the cell cannot be read
 *  as the column's kind (text in a number column). */
export function readCell(text: string, kind: Kind): { value: unknown; bad: boolean } {
  const v = text.trim()
  if (v === '') return { value: null, bad: false }
  if (kind === 'int' || kind === 'number') {
    const negative = /^\(.*\)$/.test(v)
    const n = Number(v.replace(/[,$%\s()]/g, ''))
    if (!Number.isFinite(n)) return { value: null, bad: true }
    const signed = negative ? -n : n
    if (kind === 'int') {
      return Number.isInteger(signed) ? { value: signed, bad: false } : { value: null, bad: true }
    }
    return { value: signed, bad: false }
  }
  if (kind === 'boolean') {
    const low = v.toLowerCase()
    if (['true', 'yes', 'y', '1', 'x'].includes(low)) return { value: true, bad: false }
    if (['false', 'no', 'n', '0'].includes(low)) return { value: false, bad: false }
    return { value: null, bad: true }
  }
  if (kind === 'date' || kind === 'datetime') {
    const d = readDate(v)
    if (!d) return { value: null, bad: true }
    return {
      value:
        kind === 'date'
          ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
          : d,
      bad: false
    }
  }
  return { value: v, bad: false }
}

/** Whether the stored value and the file's value are the same value. */
export function sameValue(stored: unknown, next: unknown, sql: string | undefined): boolean {
  const a = stored === '' || stored === undefined ? null : stored
  const b = next === '' || next === undefined ? null : next
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  const t = String(sql ?? '').toLowerCase()
  if (t === 'bit' || typeof a === 'boolean' || typeof b === 'boolean') {
    const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'
    return truthy(a) === truthy(b)
  }
  if (t === 'date' || t.startsWith('datetime') || t === 'smalldatetime' || a instanceof Date) {
    const da = a instanceof Date ? a : readDate(String(a))
    const dbb = b instanceof Date ? b : readDate(String(b))
    if (da && dbb) {
      if (t === 'date' || typeof b === 'string') {
        return da.toISOString().slice(0, 10) === dbb.toISOString().slice(0, 10)
      }
      return Math.abs(da.getTime() - dbb.getTime()) < 1000
    }
  }
  const na = Number(a)
  const nb = Number(b)
  const numeric =
    /^(int|bigint|smallint|tinyint|decimal|numeric|float|real|money|smallmoney)\b/.test(t) ||
    (typeof a === 'number' && typeof b === 'number')
  if (numeric && Number.isFinite(na) && Number.isFinite(nb)) {
    const scale = /^(?:decimal|numeric)\(\d+,\s*(\d+)\)/.exec(t)
    const tolerance = scale ? 0.5 * 10 ** -Number(scale[1]) : 1e-9
    return Math.abs(na - nb) < tolerance
  }
  return String(a).trim() === String(b).trim()
}

const keyPart = (v: unknown): string => {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? '1' : '0'
  const s = String(v).trim()
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(s)
  if (day) return day[1]
  if (s !== '' && /^-?\d+(\.\d+)?$/.test(s)) return String(Number(s))
  return s.toLowerCase()
}

const normLabel = (v: string) =>
  v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

// ─── steps ──────────────────────────────────────────────────────────────────

interface Built {
  row: number
  key: string
  /** Fields the file gives a value for (null = clear). */
  values: Record<string, unknown>
  /** Link name → related ids the file names; absent = the file says nothing. */
  links: Record<string, Array<string | number>>
  /** Links where a value the file named resolved to nothing: the file's set
   *  is incomplete, so nothing is removed from what the record holds. */
  partial: Record<string, true>
  label: string
}

interface Plan {
  creates: Built[]
  updates: Array<{
    built: Built
    id: string | number
    patch: Record<string, unknown>
    changes: ImportRunChange[]
    stored: Record<string, unknown>
  }>
  unchanged: Array<{ built: Built; id: string | number }>
}

async function loadUser(userId: string | null): Promise<User> {
  if (!userId) throw new Error('This import needs a queuing user (created_by missing)')
  const row = await db('nivaro_users').where('id', userId).first()
  if (!row) throw new Error(`Queuing user ${userId} not found`)
  return row as User
}

async function inParallel<T>(jobs: Array<() => Promise<T>>, width: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(width, jobs.length || 1)) }, async () => {
      while (next < jobs.length) {
        const i = next++
        out[i] = await jobs[i]()
      }
    })
  )
  return out
}

const reasonOf = (err: unknown): string => {
  const e = err as { errors?: Array<{ message?: string }>; message?: string }
  const inner = e?.errors?.map((x) => x?.message).filter(Boolean)
  const raw = inner?.length ? inner.join(' · ') : String(e?.message ?? err)
  const cut = raw.lastIndexOf(' - ')
  return (
    /^(insert|update|delete|select|merge|exec|with)\b/i.test(raw) && cut > 0
      ? raw.slice(cut + 3)
      : raw
  ).slice(0, 300)
}

async function runOneTable({
  config,
  rows,
  createdBy,
  onProgress,
  dryRun = false,
  sampleLimit = 25,
  stamp = null,
  dryCreated
}: RunTableImportOptions): Promise<TableImportResult> {
  const user = await loadUser(createdBy)
  const types = await columnTypes(config.collection)
  if (types.size === 0) throw new Error(`The table ${config.collection} does not exist`)
  const noun = config.noun ?? config.collection.replace(/_/g, ' ').replace(/s$/, '')
  const phases: ImportRunPhase[] = []
  const notes: string[] = []
  const other: Array<{ label: string; count: number }> = []
  const unmatched: ImportRunUnmatched[] = []
  const items: ImportRunItem[] = []
  const skipped: Record<string, number> = {}
  const logLines: string[] = []
  const samples: ServiceImportSamples = {
    creates: [],
    updates: [],
    skipped_rows: [],
    would_create_lookups: []
  }
  const addItem = (item: ImportRunItem) => {
    if (items.length < ITEM_CAP) items.push(item)
  }
  const skip = (
    reason: string,
    row: number | null,
    key: string | null,
    label?: string | null,
    detail?: string
  ) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
    if (row != null && samples.skipped_rows.length < sampleLimit) {
      samples.skipped_rows.push({ row, key, reason })
    }
    addItem({
      kind: 'skipped',
      collection: config.collection,
      item_id: null,
      label: label ?? key ?? `row ${row ?? ''}`.trim(),
      row: row,
      message: detail ? `${reason}: ${detail}` : reason,
      changes: []
    })
  }
  const timed = async <T>(
    key: string,
    label: string,
    fn: () => Promise<T>,
    count?: () => number
  ) => {
    const began = performance.now()
    const value = await fn()
    phases.push({ key, label, ms: Math.round(performance.now() - began), count: count?.() })
    return value
  }

  // ── 1. reference columns ──────────────────────────────────────────────────
  const lookupMaps = new Map<string, Map<string, unknown>>()
  const policyOf = (cc: TableColumn): NonNullable<TableColumn['unmatched']> =>
    cc.unmatched ??
    (cc.lookup?.on_missing === 'create'
      ? 'create'
      : cc.lookup?.on_missing === 'null'
        ? 'null'
        : 'drop')
  // a scope value that names a record: resolved once per (collection, column)
  const nested = new Map<string, Map<string, unknown>>()
  for (const cc of Object.values(config.columns)) {
    for (const spec of Object.values(cc.lookup?.scope ?? {})) {
      if (typeof spec === 'string') continue
      if (!IDENT.test(spec.lookup.collection) || !IDENT.test(spec.lookup.match_field)) {
        throw new Error('Unsafe lookup scope')
      }
      const key = `${spec.lookup.collection}.${spec.lookup.match_field}.${spec.column}`
      if (nested.has(key)) continue
      const list = [...new Set(rows.map((r) => (r[spec.column] ?? '').trim()).filter(Boolean))]
      const map = new Map<string, unknown>()
      for (let i = 0; i < list.length; i += CHUNK) {
        const found = (await db(spec.lookup.collection)
          .whereIn(spec.lookup.match_field, list.slice(i, i + CHUNK))
          .orderBy('id', 'asc')
          .select(cols('id', spec.lookup.match_field))) as Array<Record<string, unknown>>
        for (const f of found) {
          const k = String(f[spec.lookup.match_field] ?? '')
            .trim()
            .toLowerCase()
          if (!map.has(k)) map.set(k, f.id)
        }
      }
      nested.set(key, map)
    }
  }
  // a match_field that holds a reference: the file text → the id it names
  const primaryIds = new WeakMap<TableColumn, Map<string, unknown>>()
  for (const [col, cc] of Object.entries(config.columns)) {
    const ml = cc.lookup?.match_lookup
    if (!ml) continue
    if (!IDENT.test(ml.collection) || !IDENT.test(ml.match_field))
      throw new Error('Unsafe match_lookup')
    const list = [...new Set(rows.map((r) => (r[cc.from ?? col] ?? '').trim()).filter(Boolean))]
    const map = new Map<string, unknown>()
    for (let i = 0; i < list.length; i += CHUNK) {
      const found = (await db(ml.collection)
        .whereIn(ml.match_field, list.slice(i, i + CHUNK))
        .orderBy('id', 'asc')
        .select(cols('id', ml.match_field))) as Array<Record<string, unknown>>
      for (const f of found) {
        const k = String(f[ml.match_field] ?? '')
          .trim()
          .toLowerCase()
        if (!map.has(k)) map.set(k, f.id)
      }
    }
    primaryIds.set(cc, map)
  }
  const scopeValue = (spec: TableScopeValue, row: Record<string, string>): string => {
    if (typeof spec === 'string') return (row[spec] ?? '').trim()
    const cell = (row[spec.column] ?? '').trim().toLowerCase()
    const id = nested
      .get(`${spec.lookup.collection}.${spec.lookup.match_field}.${spec.column}`)
      ?.get(cell)
    // a name that names nothing can never agree with a stored value
    return id == null ? `\u0002${cell}` : String(id)
  }
  const primaryPart = (cc: TableColumn, value: string): string => {
    const first = primaryIds.get(cc)
    if (!first) return value
    const id = first.get(value.trim().toLowerCase())
    return id == null ? `\u0002${value}` : String(id)
  }
  const scopedKey = (cc: TableColumn, value: string, row: Record<string, string>) => {
    const scope = cc.lookup?.scope
    if (!scope) return primaryPart(cc, value).toLowerCase()
    return [primaryPart(cc, value), ...Object.values(scope).map((spec) => scopeValue(spec, row))]
      .join('\u0001')
      .toLowerCase()
  }
  const fallbackMaps = new Map<string, Map<string, unknown>>()
  /** Per column: the scoped keys that name several stored records under
   *  `ambiguous: 'unmatched'`. They match nothing, and they are never
   *  created either — a create would mint one more duplicate. */
  const ambiguousKeys = new Map<string, Set<string>>()
  const cellOf = (col: string, cc: TableColumn, row: Record<string, string>) =>
    (row[cc.from ?? col] ?? '').trim()
  await timed(
    'lookups',
    'Matched the names in the file',
    async () => {
      for (const [col, cc] of Object.entries(config.columns)) {
        if (!cc.lookup) continue
        const lk = cc.lookup
        const map = new Map<string, unknown>()
        const values = new Map<string, number>()
        for (const r of rows) {
          const v = cellOf(col, cc, r)
          if (v) values.set(v, (values.get(v) ?? 0) + 1)
        }
        if (lk.match_label) {
          const ids = (
            (await db(lk.collection).orderBy('id', 'asc').limit(5000).select('id')) as Array<{
              id: unknown
            }>
          ).map((r) => String(r.id))
          const labels = await getLabels(new Map([[lk.collection, new Set(ids)]]))
          const byNorm = new Map<string, string>()
          for (const id of ids) {
            const l = labels[`${lk.collection}:${id}`]
            if (l && !byNorm.has(normLabel(l))) byNorm.set(normLabel(l), id)
          }
          for (const v of values.keys()) {
            const hit = byNorm.get(normLabel(v))
            if (hit != null) map.set(v.toLowerCase(), hit)
          }
        } else {
          const field = lk.match_field
          if (!field || !IDENT.test(field)) {
            throw new Error(`Unsafe lookup config: ${lk.collection}.${String(field)}`)
          }
          const scopeCols = Object.keys(lk.scope ?? {})
          if (scopeCols.some((c) => !IDENT.test(c))) throw new Error('Unsafe lookup scope')
          const first = primaryIds.get(cc)
          const list = first
            ? [
                ...new Set(
                  [...values.keys()]
                    .map((v) => first.get(v.toLowerCase()))
                    .filter((id) => id != null)
                )
              ]
            : [...values.keys()]
          const found = await inParallel(
            Array.from(
              { length: Math.ceil(list.length / CHUNK) },
              (_, i) => () =>
                db(lk.collection)
                  .whereIn(field, list.slice(i * CHUNK, (i + 1) * CHUNK))
                  .orderBy('id', 'asc')
                  .select(cols('id', field, ...scopeCols))
            ),
            4
          )
          const held = new Map<string, number>()
          for (const r of found.flat() as Array<Record<string, unknown>>) {
            const k = [
              String(r[field] ?? '').trim(),
              ...scopeCols.map((c) => String(r[c] ?? '').trim())
            ]
              .join('\u0001')
              .toLowerCase()
            held.set(k, (held.get(k) ?? 0) + 1)
            // the lowest id wins when a name is held more than once
            if (!map.has(k)) map.set(k, r.id)
          }
          const twice = [...held.entries()].filter(([, n]) => n > 1)
          if (twice.length > 0 && lk.ambiguous === 'unmatched') {
            for (const [k] of twice) map.delete(k)
            ambiguousKeys.set(col, new Set(twice.map(([k]) => k)))
            notes.push(
              `${twice.length.toLocaleString('en-US')} ${col} value${twice.length === 1 ? '' : 's'} in the file name more than one ${lk.collection.replace(/_/g, ' ')} record, so ${twice.length === 1 ? 'it was' : 'they were'} treated as naming none.`
            )
          } else if (twice.length > 0) {
            notes.push(
              `${twice.length.toLocaleString('en-US')} ${col} value${twice.length === 1 ? '' : 's'} in the file name more than one ${lk.collection.replace(/_/g, ' ')} record. The first one (lowest id) is used.`
            )
          }
        }
        lookupMaps.set(col, map)

        // what the file names and nothing matches — an ambiguous value is
        // listed on its own: it is neither created nor "no match"
        const missing = new Map<string, number>()
        const severalOf = ambiguousKeys.get(col)
        const several = new Map<string, number>()
        // a dry run of a later step: records an earlier step would create,
        // keyed the way this lookup keys them (match value + scope values)
        const earlierRecords =
          dryRun && !lk.match_label && lk.match_field ? dryCreated?.get(lk.collection) : undefined
        const earlier = earlierRecords
          ? new Set(
              earlierRecords
                .filter((rec) => lk.match_field && rec[lk.match_field] != null)
                .map((rec) =>
                  [
                    String(rec[lk.match_field as string]).trim(),
                    ...Object.keys(lk.scope ?? {}).map((c) => String(rec[c] ?? ''))
                  ]
                    .join('\u0001')
                    .toLowerCase()
                )
            )
          : undefined
        const fromEarlier = new Set<string>()
        for (const r of rows) {
          const v = cellOf(col, cc, r)
          if (!v) continue
          if (cc.map && Object.keys(cc.map).some((k) => k.toLowerCase() === v.toLowerCase()))
            continue
          const k = scopedKey(cc, v, r)
          if (severalOf?.has(k)) several.set(v, (several.get(v) ?? 0) + 1)
          else if (!map.has(k)) {
            if (earlier?.has(k)) {
              map.set(k, `(new ${lk.collection})`)
              fromEarlier.add(v)
            } else missing.set(v, (missing.get(v) ?? 0) + 1)
          }
        }
        if (fromEarlier.size > 0) {
          notes.push(
            `${fromEarlier.size.toLocaleString('en-US')} ${col} value${fromEarlier.size === 1 ? '' : 's'} name${fromEarlier.size === 1 ? 's' : ''} a ${lk.collection.replace(/_/g, ' ')} record an earlier step of this run would create.`
          )
        }
        if (several.size > 0) {
          const policy = policyOf(cc)
          unmatched.push({
            column: col,
            label: `${col.replace(/_/g, ' ')} value naming several ${lk.collection.replace(/_/g, ' ')} records`,
            distinct: several.size,
            rows: [...several.values()].reduce((a, b) => a + b, 0),
            values: [...several.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, VALUE_SAMPLE)
              .map(([v]) => v),
            effect:
              policy === 'drop'
                ? 'The rows that carry them were left out: the file cannot say which record it means.'
                : policy === 'null'
                  ? `${cc.field.replace(/_/g, ' ')} is stored empty on those records: the file cannot say which record it means.`
                  : `Those records keep the ${cc.field.replace(/_/g, ' ')} they have; new records get none. Nothing is created for a name that already exists more than once.`
          })
        }
        if (missing.size > 0 && lk.fallback) {
          const fb = lk.fallback
          if (!IDENT.test(fb.collection) || !IDENT.test(fb.match_field)) {
            throw new Error(`Unsafe lookup fallback: ${col}`)
          }
          const list = [...missing.keys()]
          const second = new Map<string, unknown>()
          for (let i = 0; i < list.length; i += CHUNK) {
            const found = (await db(fb.collection)
              .whereIn(fb.match_field, list.slice(i, i + CHUNK))
              .orderBy('id', 'asc')
              .select(cols('id', fb.match_field))) as Array<Record<string, unknown>>
            for (const f of found) {
              const k = String(f[fb.match_field] ?? '')
                .trim()
                .toLowerCase()
              if (!second.has(k)) second.set(k, f.id)
            }
          }
          fallbackMaps.set(col, second)
          for (const v of list) if (second.has(v.toLowerCase())) missing.delete(v)
        }
        if (missing.size === 0) continue
        const policy = policyOf(cc)
        if (policy === 'create' && lk.match_field && !lk.match_label) {
          if (dryRun) {
            samples.would_create_lookups.push({
              column: col,
              collection: lk.collection,
              values: [...missing.keys()].slice(0, sampleLimit)
            })
            for (const v of missing.keys()) {
              const source = rows.find((r) => cellOf(col, cc, r) === v) ?? {}
              map.set(scopedKey(cc, v, source), `(new ${lk.collection})`)
            }
            other.push({
              label: `${lk.collection.replace(/_/g, ' ')} records would be created from ${col}`,
              count: missing.size
            })
            continue
          }
          let made = 0
          for (const v of missing.keys()) {
            const source = rows.find((r) => cellOf(col, cc, r) === v) ?? {}
            const firstId = primaryIds.get(cc)?.get(v.toLowerCase())
            if (primaryIds.has(cc) && firstId == null) {
              notes.push(
                `Could not create ${lk.collection} "${v}": no ${lk.match_lookup?.collection.replace(/_/g, ' ')} record holds that name.`
              )
              continue
            }
            const body: Record<string, unknown> = { [lk.match_field]: firstId ?? v }
            for (const [target, from] of Object.entries(lk.create_with ?? {})) {
              if (!IDENT.test(target)) continue
              const cell = (source[from] ?? '').trim()
              if (cell) body[target] = cell
            }
            for (const [target, spec] of Object.entries(lk.scope ?? {})) {
              const cell = scopeValue(spec, source)
              if (cell && !cell.startsWith('\u0002')) body[target] = cell
            }
            try {
              const created = (await createOne(
                user,
                lk.collection,
                { ...body, ...(stamp ? { _change_reason: stamp } : {}) },
                undefined,
                undefined,
                { skipRollupRecalc: true }
              )) as { id?: unknown } | null
              if (created?.id != null) {
                map.set(scopedKey(cc, v, source), created.id)
                made++
                addItem({
                  kind: 'created',
                  collection: lk.collection,
                  item_id: String(created.id),
                  label: v,
                  row: null,
                  message: `Named in ${col} and not on file before`,
                  changes: Object.entries(body).map(([field, to]) => ({ field, from: null, to }))
                })
              }
            } catch (err) {
              notes.push(`Could not create ${lk.collection} "${v}": ${reasonOf(err)}`)
            }
          }
          if (made > 0) {
            other.push({
              label: `${lk.collection.replace(/_/g, ' ')} records created from ${col}`,
              count: made
            })
          }
          continue
        }
        const onRows = [...missing.values()].reduce((a, b) => a + b, 0)
        const effect =
          policy === 'drop'
            ? `The rows that carry them were left out.`
            : policy === 'keep'
              ? `Those records keep the ${cc.field.replace(/_/g, ' ')} they have; new records get none.`
              : `${cc.field.replace(/_/g, ' ')} is stored empty on those records.`
        unmatched.push({
          column: col,
          label: `${col.replace(/_/g, ' ')} value`,
          distinct: missing.size,
          rows: onRows,
          values: [...missing.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, VALUE_SAMPLE)
            .map(([v]) => v),
          effect
        })
      }
    },
    () => [...lookupMaps.values()].reduce((a, m) => a + m.size, 0)
  )

  // ── 2. one record per file row ────────────────────────────────────────────
  const built: Built[] = []
  let cleared = 0
  let shortYears = 0
  const badCells = new Map<string, number>()
  const linkLookups = new Map<string, Map<string, unknown>>()
  /** via link → (id the source link resolved → the column's value). */
  const viaColumns = new Map<string, Map<string, unknown>>()
  for (const [name, link] of Object.entries(config.links ?? {})) {
    if (!link.lookup || link.via || !link.column) continue
    if (!IDENT.test(link.lookup.collection) || !IDENT.test(link.lookup.match_field)) {
      throw new Error(`Unsafe link lookup: ${name}`)
    }
    const values = new Set<string>()
    const sep = link.separator ?? ','
    for (const r of rows) {
      for (const part of String(r[link.column] ?? '').split(sep)) {
        const v = part.trim()
        if (v) values.add(v)
      }
    }
    const list = [...values]
    const map = new Map<string, unknown>()
    const heldBy = new Map<string, number>()
    for (let i = 0; i < list.length; i += CHUNK) {
      const found = (await db(link.lookup.collection)
        .whereIn(link.lookup.match_field, list.slice(i, i + CHUNK))
        .orderBy('id', 'asc')
        .select(cols('id', link.lookup.match_field))) as Array<Record<string, unknown>>
      for (const f of found) {
        const k = String(f[link.lookup.match_field] ?? '')
          .trim()
          .toLowerCase()
        heldBy.set(k, (heldBy.get(k) ?? 0) + 1)
        if (!map.has(k)) map.set(k, f.id)
      }
    }
    const shared = [...heldBy.entries()].filter(([, count]) => count > 1)
    if (shared.length > 0) {
      const refuse = link.lookup.ambiguous === 'unmatched'
      if (refuse) for (const [k] of shared) map.delete(k)
      notes.push(
        `${shared.length.toLocaleString('en-US')} ${link.column} value${shared.length === 1 ? '' : 's'} in the file name more than one ${link.lookup.collection.replace(/_/g, ' ')} record${refuse ? ', so no link was made for them' : '. The first one (lowest id) is linked'}: ${shared
          .slice(0, 5)
          .map(([k, count]) => `${k} (${count})`)
          .join(', ')}.`
      )
    }
    linkLookups.set(name, map)
    const missing = list.filter((v) => !map.has(v.toLowerCase()))
    if (missing.length > 0) {
      const column = link.column
      unmatched.push({
        column,
        label: `${column.replace(/_/g, ' ')} value`,
        distinct: missing.length,
        rows: rows.filter((r) =>
          String(r[column] ?? '')
            .split(sep)
            .some((p) => missing.includes(p.trim()))
        ).length,
        values: missing.slice(0, VALUE_SAMPLE),
        effect:
          (link.mode ?? 'replace') === 'replace'
            ? 'Those links were not made, and the records naming them keep the links they have.'
            : 'Those links were not made.'
      })
    }
  }
  for (const [name, link] of Object.entries(config.links ?? {})) {
    if (!link.via) continue
    const source = config.links?.[link.via.link]
    if (!source?.lookup) throw new Error(`Link ${name} is derived from a link with no lookup`)
    if (!IDENT.test(link.via.column)) throw new Error(`Unsafe via column: ${name}`)
    const ids = [...new Set([...(linkLookups.get(link.via.link)?.values() ?? [])].map(String))]
    const map = new Map<string, unknown>()
    for (let i = 0; i < ids.length; i += CHUNK) {
      const found = (await db(source.lookup.collection)
        .whereIn('id', ids.slice(i, i + CHUNK))
        .select(cols('id', link.via.column))) as Array<Record<string, unknown>>
      for (const f of found) map.set(String(f.id), f[link.via.column])
    }
    const blank = ids.filter((id) => map.get(id) == null || map.get(id) === '').length
    if (blank > 0) {
      notes.push(
        `${blank.toLocaleString('en-US')} ${link.via.link.replace(/_/g, ' ')} record${blank === 1 ? ' has' : 's have'} no ${link.via.column.replace(/_/g, ' ')}, so ${name.replace(/_/g, ' ')} could not follow from ${blank === 1 ? 'it' : 'them'}.`
      )
    }
    viaColumns.set(name, map)
  }

  await timed(
    'read-rows',
    'Read the rows',
    async () => {
      for (const [ri, r] of rows.entries()) {
        const rowNo = ri + 1
        const values: Record<string, unknown> = {}
        let drop: string | null = null
        let dropDetail: string | undefined
        for (const [col, cc] of Object.entries(config.columns)) {
          const raw = cellOf(col, cc, r)
          const mapped =
            cc.map && raw
              ? Object.entries(cc.map).find(([k]) => k.toLowerCase() === raw.toLowerCase())
              : undefined
          if (mapped) {
            values[cc.field] = mapped[1]
            continue
          }
          if (cc.map && raw && cc.map_else !== undefined) {
            values[cc.field] = cc.map_else
            continue
          }
          if (raw === '') {
            if (cc.default !== undefined) values[cc.field] = cc.default
            else if (cc.blank === 'keep') continue
            else if (cc.lookup && policyOf(cc) === 'drop' && cc.blank !== 'clear') {
              // a lookup the row cannot do without: an empty cell drops the
              // row, whether the drop policy is written out or the default
              drop = `empty ${col}`
              break
            } else values[cc.field] = null
            continue
          }
          if (cc.lookup) {
            const id = lookupMaps.get(col)?.get(scopedKey(cc, raw, r))
            if (id != null) {
              values[cc.field] = id
              Object.assign(values, cc.lookup.then ?? {})
              continue
            }
            const second = fallbackMaps.get(col)?.get(raw.toLowerCase())
            if (second != null) {
              values[cc.field] = second
              Object.assign(values, cc.lookup.fallback?.then ?? {})
              continue
            }
            const policy = policyOf(cc)
            const several = ambiguousKeys.get(col)?.has(scopedKey(cc, raw, r)) === true
            if (policy === 'drop') {
              drop = several
                ? `${col} names more than one ${cc.lookup.collection}`
                : `no ${cc.lookup.collection} match for ${col}`
              break
            }
            // a value naming several records is kept, never created; a row
            // that cannot do without it says why it was left out
            if (policy === 'keep' || (several && policy === 'create')) {
              if (
                several &&
                (config.require_value?.includes(cc.field) || config.match_by.includes(cc.field))
              ) {
                drop = `${col} names more than one ${cc.lookup.collection}`
                break
              }
              continue
            }
            values[cc.field] = null
            continue
          }
          const text =
            cc.case === 'upper' ? raw.toUpperCase() : cc.case === 'lower' ? raw.toLowerCase() : raw
          const kind = kindOf(types.get(cc.field)?.sql, cc.type)
          const cell = readCell(text, kind)
          if (
            !cell.bad &&
            (kind === 'date' || kind === 'datetime') &&
            /^\d{1,2}[/-]\d{1,2}[/-]\d{2}(\s|$)/.test(text.trim())
          ) {
            shortYears++
          }
          if (cell.bad) {
            badCells.set(col, (badCells.get(col) ?? 0) + 1)
            if (config.match_by.includes(cc.field)) {
              drop = `${col} cannot be read`
              dropDetail = `"${raw.slice(0, 40)}"`
              break
            }
            // one unreadable cell never costs the row or the stored value
            continue
          }
          values[cc.field] = cell.value
        }
        if (!drop && config.month_from) {
          const y = Number.parseInt((r[config.month_from.year_column] ?? '').trim(), 10)
          const m = Number.parseInt((r[config.month_from.month_column] ?? '').trim(), 10)
          if (
            !Number.isInteger(y) ||
            y < 2000 ||
            y > 2100 ||
            !Number.isInteger(m) ||
            m < 1 ||
            m > 12
          ) {
            drop = 'invalid year/month'
          } else values[config.month_from.field] = `${y}-${pad(m)}-01`
        }
        if (!drop) {
          for (const f of config.require_value ?? []) {
            if (values[f] == null) {
              drop = `empty ${f}`
              break
            }
          }
        }
        if (!drop) {
          for (const f of config.match_by) {
            if (values[f] == null && !(config.match_optional ?? []).includes(f)) {
              drop = `empty ${f}`
              break
            }
          }
        }
        const key = config.match_by.map((f) => keyPart(values[f])).join('|')
        const label = String(
          (config.label_field ? values[config.label_field] : null) ??
            config.match_by
              .map((f) => values[f])
              .filter((v) => v != null)
              .join(' / ') ??
            ''
        )
        if (drop) {
          skip(drop, rowNo, key || null, label || null, dropDetail)
          continue
        }
        const links: Built['links'] = {}
        const partial: Built['partial'] = {}
        for (const [name, link] of Object.entries(config.links ?? {})) {
          if (link.via) continue
          const cell = String(r[link.column ?? ''] ?? '').trim()
          if (!cell) continue
          const map = linkLookups.get(name)
          const ids: Array<string | number> = []
          for (const part of cell.split(link.separator ?? ',')) {
            const v = part.trim()
            if (!v) continue
            const id = map ? map.get(v.toLowerCase()) : v
            if (id == null) partial[name] = true
            else if (!ids.some((x) => String(x) === String(id))) ids.push(id as string | number)
          }
          links[name] = ids
        }
        // a link derived from what another link resolved
        for (const [name, link] of Object.entries(config.links ?? {})) {
          if (!link.via) continue
          const from = links[link.via.link]
          if (!from) continue
          const through = viaColumns.get(name)
          const ids: Array<string | number> = []
          for (const id of from) {
            const v = through?.get(String(id))
            if (v == null || v === '') partial[name] = true
            else if (!ids.some((x) => String(x) === String(v))) ids.push(v as string | number)
          }
          if (partial[link.via.link]) partial[name] = true
          links[name] = ids
        }
        built.push({ row: rowNo, key, values, links, partial, label: label || `row ${rowNo}` })
      }
    },
    () => rows.length
  )
  for (const [col, n] of badCells) {
    notes.push(
      `${n.toLocaleString('en-US')} ${col} cell${n === 1 ? '' : 's'} could not be read as the kind of value the field stores. Those cells were ignored; the rest of each row was imported.`
    )
  }

  if (shortYears > 0) {
    notes.push(
      `${shortYears.toLocaleString('en-US')} date${shortYears === 1 ? '' : 's'} in the file ${shortYears === 1 ? 'is' : 'are'} written with a two-digit year. Years 00 to 69 are read as 2000 to 2069, years 70 to 99 as 1970 to 1999.`
    )
  }

  // the last row of a repeated key is the one that counts
  const appendOnly = config.match_by.length === 0
  const byKey = new Map<string, Built>()
  if (appendOnly) {
    for (const [i, b] of built.entries()) byKey.set(`#${i}`, b)
  } else {
    const perRow = Object.values(config.links ?? {}).some((l) => l.per_row)
    const disagreed = new Map<string, number>()
    const disagreedKeys = new Set<string>()
    const summed = Object.values(config.columns)
      .filter((c) => c.aggregate === 'sum')
      .map((c) => c.field)
    let addedUp = 0
    for (const b of built) {
      const earlier = byKey.get(b.key)
      if (earlier && summed.length > 0) {
        // the rows of one key are parts of one amount
        for (const f of summed) {
          const a = Number(earlier.values[f] ?? 0)
          const c = Number(b.values[f] ?? 0)
          b.values[f] =
            Math.round(((Number.isFinite(a) ? a : 0) + (Number.isFinite(c) ? c : 0)) * 1e6) / 1e6
        }
        for (const [f, v] of Object.entries(earlier.values)) {
          if (b.values[f] == null && v != null) b.values[f] = v
        }
        addedUp++
      } else if (earlier && perRow) {
        // one link per row: the rows of a record add up
        for (const [name, ids] of Object.entries(earlier.links)) {
          const mine = b.links[name] ?? []
          b.links[name] = [...ids, ...mine.filter((m) => !ids.some((i) => String(i) === String(m)))]
        }
        Object.assign(b.partial, earlier.partial)
        for (const [f, v] of Object.entries(earlier.values)) {
          if (b.values[f] == null && v != null) b.values[f] = v
          else if (v != null && b.values[f] != null && !sameValue(v, b.values[f], undefined)) {
            // the rows of one record disagree on a plain value: the later
            // row's stands, and the disagreement is named
            disagreed.set(f, (disagreed.get(f) ?? 0) + 1)
            disagreedKeys.add(b.label)
          }
        }
      } else if (earlier) {
        skip(
          'repeated in the file (the later row is used)',
          earlier.row,
          earlier.key,
          earlier.label
        )
      }
      byKey.set(b.key, b)
    }
    if (addedUp > 0) {
      notes.push(
        `${addedUp.toLocaleString('en-US')} row${addedUp === 1 ? '' : 's'} of the file share${addedUp === 1 ? 's' : ''} a key with another row. Their ${summed.join(', ')} ${addedUp === 1 ? 'was' : 'were'} added up.`
      )
    }
    if (disagreed.size > 0) {
      const fields = [...disagreed.entries()].map(([f, n]) => `${f.replace(/_/g, ' ')} (${n})`)
      notes.push(
        `The rows of ${disagreedKeys.size.toLocaleString('en-US')} ${noun}${disagreedKeys.size === 1 ? '' : 's'} disagree with each other on ${fields.join(', ')}; the row later in the file decides. For example: ${[...disagreedKeys].slice(0, 3).join(', ')}.`
      )
    }
  }

  // ── 3. compare with what is stored ────────────────────────────────────────
  const compareFields = [
    ...new Set([
      ...Object.values(config.columns).map((c) => c.field),
      ...(config.month_from ? [config.month_from.field] : []),
      ...Object.keys(config.compute ?? {}),
      ...Object.keys(config.set_on_update ?? {})
    ])
  ].filter((f) => types.has(f))
  const computeSources = new Set<string>()
  const computed = Object.entries(config.compute ?? {}).map(([field, formula]) => {
    const expr = parser.parse(formula)
    for (const v of expr.variables()) if (types.has(v)) computeSources.add(v)
    return { field, expr }
  })
  // fields a follow-up step is scoped by ('$touched.project')
  const touchedFields = [
    ...new Set(
      (config.after ?? []).flatMap((step) =>
        typeof step === 'string'
          ? []
          : Object.values(step.args ?? {}).flatMap((v) =>
              typeof v === 'string' && v.startsWith('$touched.')
                ? [v.slice(9)]
                : v && typeof v === 'object'
                  ? [v.touched]
                  : []
            )
      )
    )
  ].filter((f) => types.has(f))
  const touchedValues = new Map<string, Set<string>>(touchedFields.map((f) => [f, new Set()]))
  const noteTouched = (...rows: Array<Record<string, unknown> | undefined>) => {
    for (const f of touchedFields) {
      for (const row of rows) {
        const v = row?.[f]
        if (v != null && v !== '') touchedValues.get(f)?.add(String(v))
      }
    }
  }
  const selectFields = [
    ...new Set(['id', ...config.match_by, ...compareFields, ...computeSources, ...touchedFields])
  ].filter((f) => types.has(f))
  const existing = new Map<string, Array<Record<string, unknown>>>()
  await timed(
    'compare',
    `Compared the file with the stored ${noun}s`,
    async () => {
      if (appendOnly || byKey.size === 0) return
      const first =
        config.match_by.find((f) => !(config.match_optional ?? []).includes(f)) ??
        config.match_by[0]
      // a dry-run placeholder for a record another step would create names
      // nothing stored (and would not convert for an int column)
      const firstValues = [
        ...new Set(
          [...byKey.values()]
            .map((b) => b.values[first])
            .filter((v) => v != null && !(typeof v === 'string' && v.startsWith('(new ')))
        )
      ] as Array<string | number>
      const found = await inParallel(
        Array.from(
          { length: Math.ceil(firstValues.length / CHUNK) },
          (_, i) => () =>
            db(config.collection)
              .whereIn(first, firstValues.slice(i * CHUNK, (i + 1) * CHUNK))
              .modify((q) => {
                for (const [f, v] of Object.entries(config.where ?? {})) {
                  if (!types.has(f)) throw new Error(`Unknown column in where: ${f}`)
                  if (v == null) q.whereNull(f)
                  else q.where(f, v)
                }
              })
              .orderBy('id', 'asc')
              .select(selectFields)
        ),
        6
      )
      for (const row of found.flat() as Array<Record<string, unknown>>) {
        const k = config.match_by.map((f) => keyPart(row[f])).join('|')
        if (!byKey.has(k)) continue
        existing.set(k, [...(existing.get(k) ?? []), row])
      }
    },
    () => byKey.size
  )

  const heldTwice = [...existing.entries()].filter(([, list]) => list.length > 1)
  if (heldTwice.length > 0) {
    const surplus = heldTwice.reduce((a, [, list]) => a + list.length - 1, 0)
    notes.push(
      `${heldTwice.length.toLocaleString('en-US')} ${noun}${heldTwice.length === 1 ? '' : 's'} in the file ${heldTwice.length === 1 ? 'is' : 'are'} stored more than once (${surplus.toLocaleString('en-US')} extra cop${surplus === 1 ? 'y' : 'ies'}). ${config.duplicates === 'all' ? 'Every copy was brought up to date.' : config.duplicates === 'refuse' ? 'Those rows were left out: the file cannot say which record it means.' : 'The first copy (lowest id) was brought up to date; the others were not touched.'} For example: ${heldTwice
        .slice(0, 5)
        .map(([k]) => byKey.get(k)?.label ?? k)
        .join(', ')}.`
    )
    other.push({ label: `${noun}s stored more than once`, count: heldTwice.length })
  }

  const evaluate = (values: Record<string, unknown>, stored?: Record<string, unknown>) => {
    for (const c of computed) {
      try {
        const scope: Record<string, unknown> = {}
        for (const v of c.expr.variables()) {
          const raw = v in values ? values[v] : stored?.[v]
          const n = Number(raw)
          scope[v] = raw == null || raw === '' ? 0 : Number.isFinite(n) ? n : raw
        }
        const result = c.expr.evaluate(scope as never)
        if (typeof result === 'number' && !Number.isFinite(result)) continue
        values[c.field] = result
      } catch {
        // an expression that cannot be evaluated leaves the field alone
      }
    }
  }

  const plan: Plan = { creates: [], updates: [], unchanged: [] }
  for (const [k, b] of byKey) {
    const stored = existing.get(k) ?? []
    if (stored.length === 0) {
      if (config.update_only) {
        skip(`no stored ${noun} matches (this import only updates)`, b.row, b.key, b.label)
        continue
      }
      evaluate(b.values)
      for (const [f, v] of Object.entries({ ...(config.where ?? {}), ...(config.set ?? {}) })) {
        if (types.has(f) && v != null && b.values[f] == null) b.values[f] = v
      }
      plan.creates.push(b)
      continue
    }
    if (config.create_only) {
      plan.unchanged.push({ built: b, id: stored[0].id as string | number })
      continue
    }
    if (stored.length > 1 && config.duplicates === 'refuse') {
      skip(
        `names more than one stored ${noun}`,
        b.row,
        b.key,
        b.label,
        `${stored.length} ${noun}s, ids ${stored
          .slice(0, 5)
          .map((r) => r.id)
          .join(', ')}${stored.length > 5 ? ', …' : ''}`
      )
      continue
    }
    const targets = config.duplicates === 'all' ? stored : stored.slice(0, 1)
    for (const row of targets) {
      const values: Record<string, unknown> = { ...b.values, ...(config.set_on_update ?? {}) }
      evaluate(values, row)
      const patch: Record<string, unknown> = {}
      const changes: ImportRunChange[] = []
      for (const f of compareFields) {
        if (config.match_by.includes(f) || !(f in values)) continue
        if (sameValue(row[f], values[f], types.get(f)?.sql)) continue
        patch[f] = values[f]
        changes.push({ field: f, from: row[f] ?? null, to: values[f] ?? null })
        if (values[f] == null && row[f] != null && !(f in (config.set_on_update ?? {}))) cleared++
      }
      const id = row.id as string | number
      if (changes.length === 0) plan.unchanged.push({ built: b, id })
      else plan.updates.push({ built: b, id, patch, changes, stored: row })
    }
  }
  if (cleared > 0) {
    notes.push(
      `${cleared.toLocaleString('en-US')} stored value${cleared === 1 ? ' was' : 's were'} cleared because the file's cell is empty.`
    )
  }

  // ── 4. write what differs ─────────────────────────────────────────────────
  const total = plan.creates.length + plan.updates.length
  let created = 0
  let updated = 0
  let failed = 0
  const failures: string[] = []
  const idOfKey = new Map<string, string | number>()
  for (const u of plan.unchanged) idOfKey.set(u.built.key, u.id)
  for (const u of plan.updates) if (!idOfKey.has(u.built.key)) idOfKey.set(u.built.key, u.id)
  // a dry run has no id for a record it would create; a placeholder lets
  // the links step count what that record would be linked to
  if (dryRun)
    for (const c of plan.creates) if (!idOfKey.has(c.key)) idOfKey.set(c.key, `(new ${noun})`)
  const touched: Array<string | number> = []
  const now = new Date()
  const stampCreate = config.timestamps?.create
  const stampUpdate = config.timestamps?.update

  if (dryRun) {
    created = plan.creates.length
    updated = plan.updates.length
    for (const c of plan.creates.slice(0, sampleLimit)) {
      samples.creates.push({ key: c.key, values: c.values })
    }
    if (dryCreated) {
      // what a later step may look up as if it were on file
      const list = dryCreated.get(config.collection) ?? []
      dryCreated.set(config.collection, list)
      for (const c of plan.creates) list.push(c.values)
    }
    for (const u of plan.updates.slice(0, sampleLimit)) {
      samples.updates.push({
        key: u.built.key,
        id: u.id,
        changes: u.changes.map((c) => ({ field: c.field, from: c.from, to: c.to }))
      })
    }
  } else if (total > 0) {
    const fields = [
      ...new Set([
        ...plan.creates.flatMap((c) => Object.keys(c.values)),
        ...plan.updates.flatMap((u) => Object.keys(u.patch))
      ])
    ]
    const wanted = config.write?.mode ?? 'items'
    const over = config.write?.batch_over ?? DEFAULT_BATCH_OVER
    let mode: 'items' | 'batch' =
      wanted === 'batch' || (wanted === 'auto' && total > over) ? 'batch' : 'items'
    if (mode === 'batch') {
      const refusals = [
        plan.creates.length ? await batchRefusal(user, 'create', config.collection, fields) : null,
        plan.updates.length ? await batchRefusal(user, 'update', config.collection, fields) : null
      ].filter(Boolean)
      if (refusals.length > 0) {
        mode = 'items'
        notes.push(`Written one record at a time: ${refusals[0]}.`)
      }
    }
    const progress = (done: number) =>
      void Promise.resolve(onProgress?.(done, total)).catch(() => {})

    const record = (
      kind: 'created' | 'updated',
      b: Built,
      id: string | number | null,
      changes: ImportRunChange[],
      error?: string,
      stored?: Record<string, unknown>
    ) => {
      if (error) {
        failed++
        if (failures.length < 10) failures.push(`${b.label}: ${error}`)
        addItem({
          kind: 'failed',
          collection: config.collection,
          item_id: id != null ? String(id) : null,
          label: b.label,
          row: b.row,
          message: error,
          changes
        })
        return
      }
      if (kind === 'created') created++
      else updated++
      noteTouched(stored, b.values)
      if (id != null) {
        touched.push(id)
        if (!idOfKey.has(b.key)) idOfKey.set(b.key, id)
      }
      addItem({
        kind,
        collection: config.collection,
        item_id: id != null ? String(id) : null,
        label: b.label,
        row: b.row,
        message: null,
        changes
      })
    }

    if (mode === 'batch') {
      notes.push(
        `${total.toLocaleString('en-US')} records were written together. Each has its history entry; rules that run when a person saves one record (notifications, automation) did not run.`
      )
      if (plan.creates.length > 0) {
        const out: BatchOutcome = await timed(
          'create',
          `New ${noun}s`,
          () =>
            batchCreate(
              config.collection,
              plan.creates.map((c) => ({
                body: { ...c.values, ...(stampCreate ? { [stampCreate]: now } : {}) },
                label: c.label
              })),
              {
                user,
                stamp,
                keyFields: config.match_by,
                onProgress: (done) => progress(done)
              }
            ),
          () => plan.creates.length
        )
        out.rows.forEach((r, i) => {
          const b = plan.creates[i]
          record(
            'created',
            b,
            r.id,
            Object.entries(b.values)
              .filter(([, v]) => v != null)
              .map(([field, to]) => ({ field, from: null, to })),
            r.ok ? undefined : (r.error ?? 'not written')
          )
        })
        const p = phases[phases.length - 1]
        p.failed = out.failed
      }
      if (plan.updates.length > 0) {
        const out: BatchOutcome = await timed(
          'update',
          `Changed ${noun}s`,
          () =>
            batchUpdate(
              config.collection,
              plan.updates.map((u) => ({
                id: u.id,
                patch: { ...u.patch, ...(stampUpdate ? { [stampUpdate]: now } : {}) },
                label: u.built.label
              })),
              { user, stamp, onProgress: (done) => progress(plan.creates.length + done) }
            ),
          () => plan.updates.length
        )
        out.rows.forEach((r, i) => {
          const u = plan.updates[i]
          record(
            'updated',
            u.built,
            u.id,
            r.ok && r.changes.length > 0 ? r.changes : u.changes,
            r.ok ? undefined : (r.error ?? 'not written'),
            u.stored
          )
        })
        phases[phases.length - 1].failed = out.failed
      }
    } else {
      const width = Math.max(1, Math.min(16, config.write?.width ?? 8))
      let done = 0
      const tick = () => {
        done++
        if (done % 25 === 0 || done === total) progress(done)
      }
      if (plan.creates.length > 0) {
        const before = failed
        await timed(
          'create',
          `New ${noun}s`,
          () =>
            inParallel(
              plan.creates.map((c) => async () => {
                const body: Record<string, unknown> = { ...c.values }
                if (stampCreate) body[stampCreate] = now
                if (stamp) body._change_reason = stamp
                try {
                  const made = (await createOne(user, config.collection, body)) as {
                    id?: unknown
                  } | null
                  record(
                    'created',
                    c,
                    (made?.id as string | number | undefined) ?? null,
                    Object.entries(c.values)
                      .filter(([, v]) => v != null)
                      .map(([field, to]) => ({ field, from: null, to }))
                  )
                } catch (err) {
                  record('created', c, null, [], reasonOf(err))
                }
                tick()
              }),
              width
            ),
          () => plan.creates.length
        )
        phases[phases.length - 1].failed = failed - before
      }
      if (plan.updates.length > 0) {
        const before = failed
        await timed(
          'update',
          `Changed ${noun}s`,
          () =>
            inParallel(
              plan.updates.map((u) => async () => {
                const patch: Record<string, unknown> = { ...u.patch }
                if (stampUpdate) patch[stampUpdate] = now
                if (stamp) patch._change_reason = stamp
                try {
                  await updateOne(user, config.collection, String(u.id), patch)
                  record('updated', u.built, u.id, u.changes, undefined, u.stored)
                } catch (err) {
                  record('updated', u.built, u.id, u.changes, reasonOf(err), u.stored)
                }
                tick()
              }),
              width
            ),
          () => plan.updates.length
        )
        phases[phases.length - 1].failed = failed - before
      }
    }
  }

  // ── 5. links ──────────────────────────────────────────────────────────────
  const linked: Record<string, { added: number; removed: number }> = {}
  for (const [name, link] of Object.entries(config.links ?? {})) {
    const wanted = new Map<string, Set<string>>()
    const labelOf = new Map<string, Built>()
    // records whose file set is incomplete: added to, never trimmed
    const keepRest = new Set<string>()
    for (const b of byKey.values()) {
      if (!(name in b.links)) continue
      const id = idOfKey.get(b.key)
      if (id == null) continue
      wanted.set(String(id), new Set(b.links[name].map(String)))
      labelOf.set(String(id), b)
      if (b.partial[name]) keepRest.add(String(id))
    }
    if (wanted.size === 0) continue
    if (keepRest.size > 0 && (link.mode ?? 'replace') === 'replace') {
      notes.push(
        `${keepRest.size.toLocaleString('en-US')} ${noun}${keepRest.size === 1 ? '' : 's'} named a ${name.replace(/_/g, ' ')} value that matched nothing, so ${keepRest.size === 1 ? 'its' : 'their'} existing ${name.replace(/_/g, ' ')} links were kept; only the values that matched were added.`
      )
    }
    const result = { added: 0, removed: 0 }
    await timed(
      `link-${name}`,
      `Linked ${name.replace(/_/g, ' ')}`,
      async () => {
        // a record the dry run would create holds no links yet
        const parents = [...wanted.keys()].filter((p) => !p.startsWith('(new '))
        const have = new Map<string, Array<{ id: unknown; related: string }>>()
        for (let i = 0; i < parents.length; i += CHUNK) {
          const found = (await db(link.junction)
            .whereIn(link.parent_field, parents.slice(i, i + CHUNK))
            .select('id', link.parent_field, link.related_field)) as Array<Record<string, unknown>>
          for (const f of found) {
            const p = String(f[link.parent_field])
            have.set(p, [
              ...(have.get(p) ?? []),
              { id: f.id, related: String(f[link.related_field] ?? '') }
            ])
          }
        }
        const adds: Array<{ parent: string; related: string }> = []
        const removes: Array<{ id: unknown; parent: string; related: string }> = []
        for (const [parent, set] of wanted) {
          const current = have.get(parent) ?? []
          const held = new Set(current.map((c) => c.related))
          for (const r of set) if (!held.has(r)) adds.push({ parent, related: r })
          if ((link.mode ?? 'replace') === 'replace' && !keepRest.has(parent)) {
            for (const c of current) if (!set.has(c.related)) removes.push({ ...c, parent })
          }
        }
        result.added = adds.length
        result.removed = removes.length
        if (dryRun || adds.length + removes.length === 0) return
        const registered = !!(await db('nivaro_collections')
          .where('collection', link.junction)
          .first('collection'))
        const bulk =
          !registered ||
          adds.length + removes.length > (config.write?.batch_over ?? DEFAULT_BATCH_OVER)
        const noteItem = (
          kind: 'created' | 'updated',
          parent: string,
          related: string,
          id: unknown,
          what: string
        ) =>
          addItem({
            kind,
            collection: link.junction,
            item_id: id != null ? String(id) : null,
            label: `${labelOf.get(parent)?.label ?? parent} · ${name.replace(/_/g, ' ')} ${related}`,
            row: labelOf.get(parent)?.row ?? null,
            message: what,
            changes: []
          })
        if (bulk) {
          if (removes.length > 0) {
            await batchDelete(
              link.junction,
              removes.map((r) => r.id as string | number),
              { user, stamp }
            )
          }
          if (adds.length > 0) {
            const out = await batchCreate(
              link.junction,
              adds.map((a) => ({
                body: { [link.parent_field]: a.parent, [link.related_field]: a.related }
              })),
              { user, stamp, keyFields: [link.parent_field, link.related_field] }
            )
            out.rows.forEach((r, i) => {
              if (r.ok) noteItem('created', adds[i].parent, adds[i].related, r.id, 'Linked')
              else failed++
            })
          }
          return
        }
        await inParallel(
          [
            ...removes.map((r) => async () => {
              try {
                await deleteOne(user, link.junction, String(r.id))
              } catch (err) {
                failed++
                if (failures.length < 10) failures.push(`unlink ${r.parent}: ${reasonOf(err)}`)
              }
            }),
            ...adds.map((a) => async () => {
              try {
                const made = (await createOne(user, link.junction, {
                  [link.parent_field]: a.parent,
                  [link.related_field]: a.related,
                  ...(stamp ? { _change_reason: stamp } : {})
                })) as { id?: unknown } | null
                noteItem('created', a.parent, a.related, made?.id, 'Linked')
              } catch (err) {
                failed++
                if (failures.length < 10) failures.push(`link ${a.parent}: ${reasonOf(err)}`)
              }
            })
          ],
          config.write?.width ?? 8
        )
      },
      () => result.added + result.removed
    )
    linked[name] = result
    if (result.added + result.removed > 0) {
      other.push({
        label: `${name.replace(/_/g, ' ')} links ${dryRun ? 'would change' : 'changed'} (${result.added} added, ${result.removed} removed)`,
        count: result.added + result.removed
      })
    }
  }

  // ── 6. what follows from the rows ─────────────────────────────────────────
  if (
    !dryRun &&
    (created + updated > 0 || Object.values(linked).some((l) => l.added + l.removed > 0))
  ) {
    for (const step of config.after ?? []) {
      const proc = typeof step === 'string' ? step : step.procedure
      const args: string[] = []
      let nothingToDo = false
      if (typeof step !== 'string') {
        for (const [name, v] of Object.entries(step.args ?? {})) {
          if (typeof v === 'string' && v.startsWith('$touched.')) {
            const list = [...(touchedValues.get(v.slice(9)) ?? [])].filter((x) =>
              /^[\w.-]+$/.test(x)
            )
            if (list.length === 0) nothingToDo = true
            args.push(`@${name} = '${list.join(',')}'`)
          } else if (v && typeof v === 'object') {
            // one record further: the column of the records the field names
            const ids = [...(touchedValues.get(v.touched) ?? [])]
            const found = new Set<string>()
            for (let i = 0; i < ids.length; i += CHUNK) {
              const got = (await db(v.collection)
                .whereIn('id', ids.slice(i, i + CHUNK))
                .whereNotNull(v.column)
                .select(v.column)) as Array<Record<string, unknown>>
              for (const g of got) found.add(String(g[v.column]))
            }
            const list = [...found].filter((x) => /^[\w.-]+$/.test(x))
            if (list.length === 0) nothingToDo = true
            args.push(`@${name} = '${list.join(',')}'`)
          } else if (typeof v === 'number') {
            args.push(`@${name} = ${Number(v)}`)
          } else {
            args.push(`@${name} = '${String(v).replace(/'/g, "''")}'`)
          }
        }
      }
      if (nothingToDo) continue
      const began = performance.now()
      try {
        await runLongSql(`EXEC ${proc}${args.length ? ` ${args.join(', ')}` : ''}`)
        phases.push({
          key: `after-${proc}`,
          label: proc,
          ms: Math.round(performance.now() - began)
        })
        logLines.push(`  ${proc}: ${((performance.now() - began) / 1000).toFixed(1)}s`)
      } catch (err) {
        phases.push({
          key: `after-${proc}`,
          label: proc,
          ms: Math.round(performance.now() - began),
          failed: 1
        })
        notes.push(`${proc} did not finish: ${reasonOf(err)}`)
        logLines.push(`  failed ${proc}: ${reasonOf(err)}`)
      }
    }
  } else if (!dryRun && (config.after?.length ?? 0) > 0) {
    notes.push('Nothing changed, so the follow-up steps were not run.')
  }

  // ── the log, as text ──────────────────────────────────────────────────────
  const n = (v: number) => v.toLocaleString('en-US')
  const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0)
  const head = [
    `${n(created)} created`,
    `${n(updated)} updated`,
    `${n(plan.unchanged.length)} unchanged`,
    skippedTotal ? `${n(skippedTotal)} skipped` : null,
    failed ? `${n(failed)} FAILED` : null
  ]
    .filter(Boolean)
    .join(', ')
  const detail: string[] = []
  for (const [reason, count] of Object.entries(skipped))
    detail.push(`  skipped ${n(count)}: ${reason}`)
  for (const u of unmatched) {
    const several = u.label.includes(' naming several ')
    const head = several
      ? `${n(u.distinct)} ${u.label.replace(' value naming several ', ` value${u.distinct === 1 ? '' : 's'} naming several `)}`
      : `no match for ${n(u.distinct)} ${u.label}${u.distinct === 1 ? '' : 's'}`
    detail.push(
      `  ${head} on ${n(u.rows)} rows (${u.effect.replace(/\.$/, '').toLowerCase()}): ${u.values.slice(0, 5).join(' | ')}`
    )
  }
  for (const p of phases) {
    if (p.key === 'create' || p.key === 'update') {
      detail.push(
        `  ${p.label.toLowerCase()}: ${n(p.count ?? 0)} written in ${(p.ms / 1000).toFixed(1)}s`
      )
    }
  }
  for (const [name, l] of Object.entries(linked)) {
    if (l.added + l.removed > 0) {
      detail.push(
        `  ${name.replace(/_/g, ' ')} links: ${n(l.added)} added, ${n(l.removed)} removed`
      )
    }
  }
  for (const f of failures) detail.push(`  failed ${f}`)

  return {
    created,
    updated,
    unchanged: plan.unchanged.length,
    skipped,
    failed,
    log: [head, ...detail, ...logLines].join('\n'),
    ...(dryRun ? { samples } : {}),
    affected: touched.length ? { [config.collection]: [...new Set(touched)] } : {},
    matched: (() => {
      const ids = new Set<string | number>([
        ...touched,
        ...plan.unchanged.map((u) => u.id),
        ...plan.updates.map((u) => u.id)
      ])
      return ids.size ? { [config.collection]: [...ids] } : {}
    })(),
    report: { phases, unmatched, notes, other },
    items
  }
}

/** One file, one table or several in order. A later step reads what an
 *  earlier one wrote, so a file that names a record and its related rows can
 *  fill both. */
export async function runTableImport(opts: RunTableImportOptions): Promise<TableImportResult> {
  const steps = opts.config.steps
  if (!steps || steps.length === 0) return runOneTable(opts)
  const out: TableImportResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: {},
    failed: 0,
    log: '',
    affected: {},
    matched: {},
    report: { phases: [], unmatched: [], notes: [], other: [] },
    items: []
  }
  const sections: string[] = []
  const merge = (
    into: Record<string, Array<string | number>>,
    from: Record<string, Array<string | number>>
  ) => {
    for (const [c, ids] of Object.entries(from))
      into[c] = [...new Set([...(into[c] ?? []), ...ids])]
  }
  const dryCreated = opts.dryRun ? new Map<string, Array<Record<string, unknown>>>() : undefined
  for (const [i, step] of steps.entries()) {
    const title = step.noun ?? step.collection.replace(/_/g, ' ')
    const r = await runOneTable({ ...opts, config: step, dryCreated })
    out.created += r.created
    out.updated += r.updated
    out.unchanged += r.unchanged
    out.failed += r.failed
    for (const [reason, count] of Object.entries(r.skipped)) {
      const key = `${title}: ${reason}`
      out.skipped[key] = (out.skipped[key] ?? 0) + count
    }
    merge(out.affected, r.affected)
    merge(out.matched, r.matched)
    out.report.phases.push(
      ...r.report.phases.map((p) => ({
        ...p,
        key: `${i + 1}-${p.key}`,
        label: `${title}: ${p.label}`
      }))
    )
    out.report.unmatched.push(...r.report.unmatched)
    out.report.notes.push(...r.report.notes.map((n) => `${title}: ${n}`))
    out.report.other.push(...r.report.other)
    for (const item of r.items) if (out.items.length < ITEM_CAP) out.items.push(item)
    const [head, ...rest] = r.log.split('\n')
    sections.push(`  ${title}: ${head}`, ...rest)
    if (opts.dryRun && r.samples) {
      out.samples ??= { creates: [], updates: [], skipped_rows: [], would_create_lookups: [] }
      out.samples.creates.push(...r.samples.creates)
      out.samples.updates.push(...r.samples.updates)
      out.samples.skipped_rows.push(...r.samples.skipped_rows)
      out.samples.would_create_lookups.push(...r.samples.would_create_lookups)
    }
  }
  const n = (v: number) => v.toLocaleString('en-US')
  const skippedTotal = Object.values(out.skipped).reduce((a, b) => a + b, 0)
  out.log = [
    [
      `${n(out.created)} created`,
      `${n(out.updated)} updated`,
      `${n(out.unchanged)} unchanged`,
      skippedTotal ? `${n(skippedTotal)} skipped` : null,
      out.failed ? `${n(out.failed)} FAILED` : null
    ]
      .filter(Boolean)
      .join(', '),
    ...sections
  ].join('\n')
  return out
}
