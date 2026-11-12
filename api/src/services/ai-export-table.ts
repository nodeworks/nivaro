import { csvCell } from '../lib/csv-cell.js'
import { parseNaiveDate, zonedWallTime } from './ai-local-dates.js'

/**
 * The file behind an Ask AI answer, as a table a person can read.
 *
 * The rows an answer exports are a tool's own result: a query that asked for
 * `project_type.name` gets the linked record back as `{id, name}`, a plain
 * link comes back as `{id, label}`, a timestamp is a UTC instant and the keys
 * are column names. Written out as they are, the first week's export read
 * `{"id":28,"name":"Genesis"}` under a header called `project_type`.
 *
 * Here every cell becomes what the list on screen would show — a linked
 * record by its name, several by their names, a timestamp in the reader's
 * time zone, yes/no — under the field's label. Pure: the caller supplies the
 * labels, which columns hold what kind of date, and the time zone.
 */

/**
 * instant = a moment in time (stored UTC): shown in the reader's zone.
 * naive   = a clock time stored as written: never shifted.
 * date    = a calendar date: never shifted, never given a time.
 */
export type DateKind = 'instant' | 'naive' | 'date'

/** A date the spreadsheet can sort: the text people read plus the day number Excel keeps. */
export interface DateCell {
  date: true
  text: string
  serial: number
  time: boolean
}

export type ExportCell = string | number | DateCell | null

export interface ExportTable {
  headers: string[]
  rows: ExportCell[][]
}

export interface ExportMeta {
  /** The query's own `fields`, in order (dotted through links). Absent = every column. */
  fields?: string[]
  /** The configured label of a field, by dotted path. */
  label?: (path: string) => string | null | undefined
  /** What kind of date a field holds, by dotted path. */
  kind?: (path: string) => DateKind | null | undefined
  /** The reader's time zone (timestamps are shown in it). */
  timeZone?: string
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)

const isDateCell = (c: unknown): c is DateCell => isObject(c) && c.date === true

/** The text of a cell (what CSV writes and what a person reads). */
export function cellText(cell: ExportCell): string {
  if (cell == null) return ''
  return isDateCell(cell) ? cell.text : String(cell)
}

const UPPER = new Set(['id', 'url', 'pdf', 'api', 'sku'])

function words(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) =>
      UPPER.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)
    )
    .join(' ')
}

/** A column header: the field's label when it has one, else its name in plain words. */
export function headerFor(path: string, label?: ExportMeta['label']): string {
  const own = label?.(path)
  if (typeof own === 'string' && own.trim()) return own.trim()
  return words(path.split('.').pop() ?? path)
}

const pad = (n: number) => String(n).padStart(2, '0')

const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  if (typeof v !== 'string') return null
  if (ZONED.test(v)) {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  }
  // A zone-less value is read as written (UTC parts), never in the server's zone.
  const w = parseNaiveDate(v)
  return w ? new Date(Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s, w.ms)) : null
}

function dateCell(d: Date, kind: DateKind | null | undefined, timeZone?: string): DateCell {
  const w =
    kind === 'instant' && timeZone
      ? zonedWallTime(d, timeZone)
      : {
          y: d.getUTCFullYear(),
          m: d.getUTCMonth() + 1,
          d: d.getUTCDate(),
          h: d.getUTCHours(),
          mi: d.getUTCMinutes(),
          s: d.getUTCSeconds()
        }
  // A timestamp always carries its time; a stored clock time only when it has one.
  const time = kind === 'instant' || (kind !== 'date' && (w.h !== 0 || w.mi !== 0 || w.s !== 0))
  const day = `${w.y}-${pad(w.m)}-${pad(w.d)}`
  const text = time
    ? `${day} ${w.h % 12 === 0 ? 12 : w.h % 12}:${pad(w.mi)} ${w.h < 12 ? 'AM' : 'PM'}`
    : day
  // Excel counts days from 1899-12-30; the fraction is the time of day.
  const serial = Date.UTC(w.y, w.m - 1, w.d, time ? w.h : 0, time ? w.mi : 0) / 86_400_000 + 25_569
  return { date: true, text, serial, time }
}

/** A linked record (or plain data) as text: its name, never its braces. */
function objectText(v: Record<string, unknown>, timeZone?: string): string | number | null {
  if ('label' in v) {
    const label = displayCell(v.label, { timeZone })
    if (label != null) return isDateCell(label) ? label.text : label
    return v.id == null ? null : (displayCell(v.id) as string | number | null)
  }
  const linked = 'id' in v
  const parts: string[] = []
  for (const [k, val] of Object.entries(v)) {
    if (linked && k === 'id') continue
    const text = cellText(displayCell(val, { timeZone }))
    if (!text) continue
    // A linked record reads as its values ("Steven Moye"); plain data keeps its keys.
    parts.push(linked ? text : `${words(k)}: ${text}`)
  }
  if (parts.length) return parts.join(linked ? ' ' : '; ')
  // Only an id came back: that is all the reader may see of the linked record.
  if (!linked || v.id == null) return null
  return typeof v.id === 'number' ? v.id : String(v.id)
}

/** What one value shows in the file. */
export function displayCell(
  v: unknown,
  ctx: { kind?: DateKind | null; timeZone?: string } = {}
): ExportCell {
  if (v == null || v === '') return null
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'bigint') return String(v)
  if (v instanceof Date) {
    const d = toDate(v)
    return d ? dateCell(d, ctx.kind, ctx.timeZone) : null
  }
  if (typeof v === 'string') {
    // Text is only read as a date in a column known to hold one.
    const d = ctx.kind ? toDate(v) : null
    return d ? dateCell(d, ctx.kind, ctx.timeZone) : v
  }
  if (Array.isArray(v)) {
    const parts = v.map((x) => cellText(displayCell(x, { timeZone: ctx.timeZone }))).filter(Boolean)
    return parts.length ? parts.join(', ') : null
  }
  if (isObject(v)) return objectText(v, ctx.timeZone)
  return String(v)
}

interface Column {
  header: string
  cell: (row: Record<string, unknown>) => ExportCell
}

/** `{id, label}` — a link the tool labelled instead of opening. */
const isLabelled = (v: unknown) => isObject(v) && 'label' in v

function dig(value: unknown, sub: string[]): unknown {
  let cur: unknown = value
  for (const seg of sub) {
    if (!isObject(cur) || isLabelled(cur)) return undefined
    cur = seg in cur ? cur[seg] : null
  }
  return cur
}

function planColumns(rows: Array<Record<string, unknown>>, meta: ExportMeta): Column[] {
  const present: string[] = []
  for (const r of rows) for (const k of Object.keys(r)) if (!present.includes(k)) present.push(k)
  const requested = (meta.fields ?? []).filter((f) => typeof f === 'string' && f.trim())
  const show = (path: string) => (v: unknown) =>
    displayCell(v, { kind: meta.kind?.(path), timeZone: meta.timeZone })

  if (requested.length === 0 || requested.includes('*')) {
    return present.map((key) => ({
      header: headerFor(key, meta.label),
      cell: (row) => show(key)(row[key])
    }))
  }

  // Group what was asked for by its first segment, in the order asked.
  const groups = new Map<string, string[][]>()
  for (const f of requested) {
    const [head, ...sub] = f.split('.').map((s) => s.trim())
    if (!groups.has(head)) groups.set(head, [])
    groups.get(head)?.push(sub)
  }
  const columns: Column[] = []
  for (const [head, subs] of groups) {
    // Asked for but not returned (no access, or past the query's field cap).
    if (rows.length > 0 && !present.includes(head)) continue
    const headLabel = headerFor(head, meta.label)
    const paths = subs.filter((s) => s.length > 0 && !s.includes('*'))
    if (paths.length === 0) {
      columns.push({ header: headLabel, cell: (row) => show(head)(row[head]) })
      continue
    }
    // The link was not opened for this reader (they cannot read the linked
    // record): the first column shows what the row holds, the rest stay blank.
    const leaf = (sub: string[], first: boolean) => (row: Record<string, unknown>) => {
      const v = dig(row[head], sub)
      if (v !== undefined) return show([head, ...sub].join('.'))(v)
      return first ? displayCell(row[head], { timeZone: meta.timeZone }) : null
    }
    if (paths.length === 1) {
      columns.push({ header: headLabel, cell: leaf(paths[0], true) })
      continue
    }
    // A person's two name columns read as one name.
    const isName = (s: string[], n: string) => s.length === 1 && s[0] === n
    const firstName = paths.find((s) => isName(s, 'first_name'))
    const lastName = paths.find((s) => isName(s, 'last_name'))
    const named = !!firstName && !!lastName
    let opened = false
    for (const sub of paths) {
      const first = !opened
      if (named && (sub === firstName || sub === lastName)) {
        if (sub !== firstName) continue
        opened = true
        columns.push({
          header: headLabel,
          cell: (row) => {
            if (dig(row[head], ['first_name']) === undefined) return leaf(sub, first)(row)
            const name = [dig(row[head], ['first_name']), dig(row[head], ['last_name'])]
              .map((x) => cellText(displayCell(x)))
              .filter(Boolean)
              .join(' ')
            return name || null
          }
        })
        continue
      }
      opened = true
      const subLabel = headerFor([head, ...sub].join('.'), meta.label)
      columns.push({
        header: subLabel.toLowerCase().startsWith(headLabel.toLowerCase())
          ? subLabel
          : `${headLabel} ${subLabel}`,
        cell: leaf(sub, first)
      })
    }
  }
  return columns
}

/** Rows of a tool result as a labelled table. */
export function buildExportTable(
  rows: Array<Record<string, unknown>>,
  meta: ExportMeta = {}
): ExportTable {
  const columns = planColumns(rows, meta)
  const seen = new Map<string, number>()
  const headers = columns.map((c) => {
    const n = (seen.get(c.header) ?? 0) + 1
    seen.set(c.header, n)
    return n === 1 ? c.header : `${c.header} (${n})`
  })
  return { headers, rows: rows.map((r) => columns.map((c) => c.cell(r))) }
}

/** CSV: every text cell quoted and formula-safe, real numbers left as numbers. */
export function tableToCsv(table: ExportTable): string {
  const cell = (c: ExportCell) =>
    typeof c === 'number' && Number.isFinite(c) ? String(c) : csvCell(cellText(c))
  return [
    table.headers.map(csvCell).join(','),
    ...table.rows.map((r) => r.map(cell).join(','))
  ].join('\r\n')
}

/**
 * The table as an array of arrays a workbook writer takes: a date is a number
 * cell with a date format, so the spreadsheet sorts and filters it as a date.
 */
export function tableToAoa(table: ExportTable): unknown[][] {
  return [
    table.headers,
    ...table.rows.map((r) =>
      r.map((c) =>
        isDateCell(c)
          ? { t: 'n', v: c.serial, z: c.time ? 'yyyy-mm-dd h:mm AM/PM' : 'yyyy-mm-dd' }
          : c
      )
    )
  ]
}

/** Column widths that fit the content, within reason. */
export function columnWidths(table: ExportTable): Array<{ wch: number }> {
  return table.headers.map((h, i) => {
    let widest = h.length
    for (const r of table.rows.slice(0, 500)) widest = Math.max(widest, cellText(r[i]).length)
    return { wch: Math.min(60, Math.max(8, widest + 2)) }
  })
}
