/**
 * A timestamp written with a UTC offset ('2026-11-20T10:00:00+02:00') names one instant. A column
 * that keeps no offset (SQL Server datetime / datetime2 / smalldatetime, Postgres `timestamp
 * without time zone`, MySQL DATETIME) silently drops it when the database converts the text:
 * SQL Server stored 10:00 where the caller meant 08:00 UTC. Every timestamp the app writes is UTC,
 * so a record write sends such a value as its UTC instant ('2026-11-20T08:00:00Z') on every
 * database. A value without an offset, a 'Z' value, a date column and an offset-keeping column
 * (datetimeoffset / timestamptz) are left exactly as given.
 */

const OFFSET_ISO =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*([+-])(\d{2})(?::?(\d{2}))?$/

/** Column types (as SQL Server names them, see normalizeSqlType) that hold no offset. */
const NO_OFFSET_TYPES = new Set(['datetime', 'datetime2', 'smalldatetime'])

/** An ISO timestamp with a ±hh:mm offset as its UTC instant ('…Z'); any other value unchanged. */
export function utcFromOffsetTimestamp(value: unknown): unknown {
  if (typeof value !== 'string' || value.length > 40) return value
  const m = OFFSET_ISO.exec(value.trim())
  if (!m) return value
  const [, date, hh, mi, ss = '00', frac = '', sign, oh, om = '00'] = m
  const wall = Date.parse(`${date}T${hh}:${mi}:${ss}Z`)
  if (Number.isNaN(wall)) return value
  // An impossible date (02-30) is left for the database to refuse as it would anyway.
  if (new Date(wall).toISOString().slice(0, 10) !== date) return value
  const offsetMin = Number(oh) * 60 + Number(om)
  if (Number(oh) > 23 || Number(om) > 59) return value
  const utc = new Date(wall - (sign === '-' ? -1 : 1) * offsetMin * 60_000).toISOString()
  // The offset is whole minutes, so the fraction is the one the caller sent.
  return `${utc.slice(0, 19)}${frac ? `.${frac}` : ''}Z`
}

/** Every write-payload value bound for an offset-less timestamp column, in place. */
export function fitOffsetTimestamps(
  payload: Record<string, unknown>,
  shapes: Map<string, { type?: string | null }>
): void {
  if (shapes.size === 0) return
  for (const [field, value] of Object.entries(payload)) {
    if (typeof value !== 'string') continue
    const type = String(shapes.get(field.toLowerCase())?.type ?? '').toLowerCase()
    if (!NO_OFFSET_TYPES.has(type)) continue
    const fitted = utcFromOffsetTimestamp(value)
    if (fitted !== value) payload[field] = fitted
  }
}
