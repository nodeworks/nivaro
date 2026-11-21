/**
 * A path id that cannot name a row (`/tasks/abc`, `/notification-subscriptions/undefined`): most
 * routes do `Number(req.params.id)` and hand the NaN or the text straight to the database, which
 * refuses the binding — SQL Server "Validation failed for parameter … Invalid number", Postgres
 * "invalid input syntax for type integer", MySQL / MariaDB "Unknown column 'NaN'" — and the
 * request answered 500 (and opened an issue). There is no such record: the error handler answers
 * 404 instead, but only when BOTH hold — the database refused a number / uuid conversion AND an
 * id path parameter is neither an integer nor a uuid — so a conversion failure on a well-formed
 * URL (or over a body value) stays what it was.
 */

const INT = /^-?\d+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The driver text of a refused number / uuid binding, per engine. */
const CONVERSION = [
  // SQL Server (tedious validates the binding before sending; the server converts text)
  /Validation failed for parameter '[^']*'\. Invalid (number|guid|uniqueidentifier)/i,
  /Conversion failed when converting (the \w+ value '[^']*'|from a character string) to (data type )?(int|bigint|smallint|tinyint|uniqueidentifier)/i,
  // Postgres (SQLSTATE 22P02)
  /invalid input syntax for type (integer|bigint|smallint|uuid|numeric)/i,
  // MySQL / MariaDB: knex writes a NaN binding as the bare word NaN; MySQL 8's strict mode
  // refuses text against a number column in an UPDATE / DELETE (1292)
  /Unknown column 'NaN' in/i,
  /Truncated incorrect (DOUBLE|INTEGER|DECIMAL) value/i
]

function errorTextOf(err: unknown): string {
  const e = err as { message?: unknown; errors?: Array<{ message?: unknown }> }
  return [e?.message, ...(Array.isArray(e?.errors) ? e.errors.map((x) => x?.message) : [])]
    .filter((m): m is string => typeof m === 'string')
    .join(' · ')
}

/** Path parameters that name a row by id: `:id`, `:userId`, `:logId`, `:item_id`, … */
const ID_NAME = /^(id|.+Id|.+_id)$/

/** True when an id path parameter (`:id`, `:…Id`, `:…_id`) is neither an integer nor a uuid. */
export function hasMalformedIdParam(params: unknown): boolean {
  if (!params || typeof params !== 'object') return false
  return Object.entries(params as Record<string, unknown>).some(
    ([k, v]) =>
      ID_NAME.test(k) && typeof v === 'string' && v !== '' && !INT.test(v) && !UUID.test(v)
  )
}

/** True when `err` is a database refusing a malformed path id (answer 404, not 500). */
export function isMalformedIdRefusal(err: unknown, params: unknown): boolean {
  if (!hasMalformedIdParam(params)) return false
  const text = errorTextOf(err)
  return text !== '' && CONVERSION.some((re) => re.test(text))
}
