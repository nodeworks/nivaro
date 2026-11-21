/**
 * SQLite stores whatever it is given: '12.7' in an integer column, 'garbage' in a date column,
 * an 11-character name in a varchar(10). SQL Server converts a value to its column's type or
 * refuses the write. This file gives the items service (services/items.ts) SQL Server's answer
 * on SQLite:
 *
 *  - `sqliteColumnShape` names a declared SQLite type the way SQL Server's INFORMATION_SCHEMA
 *    would (int, bigint, bit, uniqueidentifier, nvarchar(n), decimal(p,s), date, datetime2), so
 *    the checks that already run on every database before a write (string length, number range,
 *    filter value fit) judge SQLite columns exactly as they judge SQL Server's.
 *  - `fitSqliteWriteValues` converts a payload's values the way SQL Server converts them on the
 *    write (' 12 ' → 12, 12.7 → 12, 'true' → true, '11/20/2026' → '2026-11-20', 12.345 in a
 *    decimal(10,2) → 12.35) and refuses what SQL Server refuses with a conversion error
 *    ('12.7' into an int, 'yes' into a bit, '2026-02-30', a uuid that is not one) — as an error
 *    lib/db-refusal.ts describeValueRefusal answers 400 VALUE_TYPE_MISMATCH / VALUE_OUT_OF_RANGE.
 *
 * Only ever called when the database is SQLite.
 */
import { type ColumnShape, UUID_RE } from '../lib/sql-value-fit.js'

export interface SqliteColumnShape extends ColumnShape {
  /** Characters a text column holds; -1 = no limit (SQL Server's nvarchar(max)). */
  length?: number | null
}

/** A declared SQLite column type (PRAGMA table_info `type`) as SQL Server would name it. */
export function sqliteColumnShape(
  declared: string | null | undefined,
  pk = false
): SqliteColumnShape {
  const t = String(declared ?? '')
    .trim()
    .toLowerCase()
  const m = /^([a-z ]+?)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?$/.exec(t)
  const base = (m?.[1] ?? t).trim()
  const a = m?.[2] != null ? Number(m[2]) : null
  const b = m?.[3] != null ? Number(m[3]) : null
  if (base === 'integer' || base === 'int') return { type: pk ? 'bigint' : 'int' }
  if (base === 'bigint' || base === 'biginteger') return { type: 'bigint' }
  if (base === 'smallint' || base === 'tinyint') return { type: base }
  if (base === 'boolean' || base === 'bool') return { type: 'bit' }
  // knex's uuid() on SQLite: char(36) — exactly the columns that are uniqueidentifier on SQL
  // Server (461 of them in a fresh install, none other).
  if (base === 'char' && a === 36) return { type: 'uniqueidentifier' }
  if (/char/.test(base)) return { type: 'nvarchar', length: a ?? 1 }
  if (base === 'text' || base === 'clob' || base === 'json' || base === 'jsonb')
    return { type: 'nvarchar', length: -1 }
  if (base === 'float' || base === 'double' || base === 'real' || base === 'double precision')
    return { type: 'float' }
  if (base === 'decimal' || base === 'numeric')
    return { type: 'decimal', precision: a ?? 18, scale: b ?? 0 }
  if (base === 'date') return { type: 'date' }
  if (base === 'datetime' || base === 'timestamp' || base === 'datetime2')
    return { type: 'datetime2' }
  return { type: base }
}

/** Why a value cannot be written: answered like SQL Server's conversion / overflow errors. */
export class SqliteValueRefusal extends Error {
  constructor(
    readonly kind: 'mismatch' | 'range',
    readonly field: string
  ) {
    super(
      kind === 'mismatch'
        ? `SQLITE_VALUE_MISMATCH: the value for ${field} does not convert to its column type`
        : `SQLITE_VALUE_OUT_OF_RANGE: the value for ${field} does not fit its column`
    )
    this.name = 'SqliteValueRefusal'
  }
}

const INT_TYPES = new Set(['int', 'bigint', 'smallint', 'tinyint'])
const INT_TEXT = /^[-+]?\d+$/
const FLOAT_TEXT = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i
const DECIMAL_TEXT = /^([-+]?)(\d*)(?:\.(\d*))?$/
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

function daysIn(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

interface WallClock {
  y: number
  mo: number
  d: number
  h: number
  mi: number
  s: number
  ms: number
}

const TIME = String.raw`(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(am|pm)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)?`

/**
 * A date/time literal as SQL Server (us_english, DATEFORMAT mdy) reads it into date / datetime2:
 * ISO 'YYYY-MM-DD[THH:MM[:SS[.fff]]]', 'YYYYMMDD', 'MM/DD/YYYY', 'Nov 20 2026', '20 Nov 2026'.
 * An offset is read and dropped — datetime2 keeps the wall clock as written. Null = SQL Server
 * would refuse the conversion ('2026-02-30', 'garbage').
 */
const month = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1

/** The date forms SQL Server reads, each with how its match gives [year, month, day]. */
const DATE_FORMS: Array<[RegExp, (m: RegExpExecArray) => [number, number, number]]> = [
  [new RegExp(`^(\\d{4})-(\\d{1,2})-(\\d{1,2})${TIME}$`, 'i'), (m) => [+m[1], +m[2], +m[3]]],
  [new RegExp(`^(\\d{4})(\\d{2})(\\d{2})${TIME}$`, 'i'), (m) => [+m[1], +m[2], +m[3]]],
  [
    new RegExp(`^(\\d{1,2})[/.-](\\d{1,2})[/.-](\\d{4})${TIME}$`, 'i'),
    (m) => [+m[3], +m[1], +m[2]]
  ],
  [
    new RegExp(`^([a-z]{3,9})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})${TIME}$`, 'i'),
    (m) => [+m[3], month(m[1]), +m[2]]
  ],
  [
    new RegExp(`^(\\d{1,2})\\s+([a-z]{3,9})\\.?,?\\s+(\\d{4})${TIME}$`, 'i'),
    (m) => [+m[3], month(m[2]), +m[1]]
  ]
]

export function parseSqlServerDateTime(text: string): WallClock | null {
  const s = text.trim()
  let rest: RegExpExecArray | null = null
  let ymdParts: [number, number, number] = [0, 0, 0]
  for (const [re, parts] of DATE_FORMS) {
    rest = re.exec(s)
    if (rest) {
      ymdParts = parts(rest)
      break
    }
  }
  if (!rest) return null
  const [y, mo, d] = ymdParts
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return null
  let h = rest[4] != null ? Number(rest[4]) : 0
  const mi = rest[5] != null ? Number(rest[5]) : 0
  const sec = rest[6] != null ? Number(rest[6]) : 0
  const ms = rest[7] != null ? Number(rest[7].slice(0, 3).padEnd(3, '0')) : 0
  const ampm = rest[8]?.toLowerCase()
  if (ampm) {
    if (h < 1 || h > 12) return null
    h = (h % 12) + (ampm === 'pm' ? 12 : 0)
  }
  if (h > 23 || mi > 59 || sec > 59) return null
  return { y, mo, d, h, mi, s: sec, ms }
}

const ymd = (c: WallClock) => `${pad(c.y, 4)}-${pad(c.mo)}-${pad(c.d)}`

/** A decimal literal rounded half away from zero to `scale` digits (SQL Server's rounding). */
function roundDecimalText(text: string, scale: number): string | null {
  const m = DECIMAL_TEXT.exec(text)
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return null
  const sign = m[1] === '-' ? '-' : ''
  let int = m[2] || '0'
  let frac = m[3] ?? ''
  if (frac.length > scale) {
    const up = frac[scale] >= '5'
    frac = frac.slice(0, scale)
    if (up) {
      const digits = (int + frac).split('').map(Number)
      let i = digits.length - 1
      while (i >= 0) {
        if (digits[i] === 9) {
          digits[i] = 0
          i--
        } else {
          digits[i]++
          break
        }
      }
      let all = digits.join('')
      if (i < 0) all = `1${all}`
      int = all.slice(0, all.length - frac.length) || '0'
      frac = all.slice(all.length - frac.length)
    }
  }
  return `${sign}${int}${frac ? `.${frac}` : ''}`
}

/** A JS number as a plain decimal literal (no exponent). */
function numberText(n: number): string {
  const s = String(n)
  if (!/e/i.test(s)) return s
  return n.toFixed(20).replace(/\.?0+$/, '')
}

/**
 * One value as SQL Server would store it in a column of this shape, or a SqliteValueRefusal.
 * Values the column takes as they are (text, null, Buffers) come back unchanged.
 */
export function fitSqliteWriteValue(
  field: string,
  value: unknown,
  shape: SqliteColumnShape
): unknown {
  if (value == null) return value
  // knex.raw / fn.now() and Buffers are the database's own business.
  if (
    typeof value === 'object' &&
    !(value instanceof Date) &&
    (Buffer.isBuffer(value) || typeof (value as { toSQL?: unknown }).toSQL === 'function')
  )
    return value
  const type = shape.type
  const mismatch = () => new SqliteValueRefusal('mismatch', field)
  if (INT_TYPES.has(type)) {
    if (typeof value === 'boolean') return value ? 1 : 0
    if (typeof value === 'bigint') return value
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw mismatch()
      return Math.trunc(value) || 0
    }
    if (typeof value === 'string') {
      const s = value.trim()
      if (s === '') return 0
      if (!INT_TEXT.test(s)) throw mismatch()
      const n = Number(s)
      // Past 2^53 the text goes on as written: SQLite reads it into its 64-bit integer exactly.
      return Number.isSafeInteger(n) ? n : s.replace(/^\+/, '')
    }
    throw mismatch()
  }
  if (type === 'float') {
    if (typeof value === 'boolean') return value ? 1 : 0
    if (typeof value === 'number' || typeof value === 'bigint') return Number(value)
    if (typeof value === 'string') {
      const s = value.trim()
      if (s === '') return 0
      if (!FLOAT_TEXT.test(s)) throw mismatch()
      return Number(s)
    }
    throw mismatch()
  }
  if (type === 'decimal') {
    const scale = shape.scale ?? 0
    let text: string
    if (typeof value === 'boolean') text = value ? '1' : '0'
    else if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw mismatch()
      text = numberText(value)
    } else if (typeof value === 'bigint') text = value.toString()
    else if (typeof value === 'string') text = value.trim()
    else throw mismatch()
    const rounded = roundDecimalText(text, scale)
    if (rounded == null) throw mismatch()
    const digits = rounded.replace(/^-/, '').split('.')[0].replace(/^0+/, '').length
    if (shape.precision && digits > shape.precision - scale)
      throw new SqliteValueRefusal('range', field)
    return Number(rounded)
  }
  if (type === 'bit') {
    if (typeof value === 'boolean') return value
    if (typeof value === 'number' || typeof value === 'bigint') return Number(value) !== 0
    if (typeof value === 'string') {
      const s = value.trim()
      if (s === '') return false
      if (/^true$/i.test(s)) return true
      if (/^false$/i.test(s)) return false
      if (INT_TEXT.test(s)) return Number(s) !== 0
    }
    throw mismatch()
  }
  if (type === 'uniqueidentifier') {
    if (typeof value !== 'string') throw mismatch()
    const s = value.trim().replace(/^\{(.*)\}$/, '$1')
    if (!UUID_RE.test(s)) throw mismatch()
    return s
  }
  if (type === 'date' || type === 'datetime2') {
    let clock: WallClock | null
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) throw mismatch()
      if (type === 'datetime2') return value
      clock = parseSqlServerDateTime(value.toISOString())
    } else if (typeof value === 'string') {
      // SQL Server reads '' as 1900-01-01.
      clock =
        value.trim() === '' ? parseSqlServerDateTime('1900-01-01') : parseSqlServerDateTime(value)
    } else throw mismatch()
    if (!clock) throw mismatch()
    if (type === 'date') return ymd(clock)
    return `${ymd(clock)}T${pad(clock.h)}:${pad(clock.mi)}:${pad(clock.s)}.${pad(clock.ms, 3)}Z`
  }
  return value
}

/** Every value of a write payload fitted in place (fitSqliteWriteValue); fields with no column untouched. */
export function fitSqliteWriteValues(
  payload: Record<string, unknown>,
  shapes: Map<string, SqliteColumnShape>
): void {
  for (const [field, value] of Object.entries(payload)) {
    const shape = shapes.get(field.toLowerCase())
    if (!shape || value === undefined) continue
    const fitted = fitSqliteWriteValue(field, value, shape)
    if (fitted !== value) payload[field] = fitted
  }
}
