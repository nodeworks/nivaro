import { isConnectFailure, isPoolBusy } from './db-unavailable.js'

/**
 * A write the DATABASE refused because of the caller's data — a foreign key
 * that points at nothing, a value that already exists under a unique index —
 * is not a server fault. Left alone it surfaces as a 500 whose message names
 * the database, the table and sometimes the statement.
 *
 * `describeDbRefusal` recognises those refusals and returns the answer the
 * caller should get: a 4xx, a machine code, and a sentence that names the
 * constraint (the one detail that tells a caller WHICH link or value) and
 * nothing else about the database.
 */
export interface DbRefusal {
  status: number
  code:
    | 'LINKED_RECORD_MISSING'
    | 'RECORD_IN_USE'
    | 'DUPLICATE_RECORD'
    | 'VALUE_TOO_LONG'
    | 'VALUE_TYPE_MISMATCH'
    | 'VALUE_OUT_OF_RANGE'
    | 'REQUIRED_VALUE_MISSING'
  message: string
}

/**
 * What a constraint refusal names, for an answer that speaks in field labels
 * (services/db-refusal-labels.ts). Internal: never sent as it is — the
 * constraint, table and column names stay on the server.
 */
export interface DbRefusalDetail {
  kind: 'fk_missing' | 'fk_in_use' | 'duplicate' | 'not_null' | 'too_long'
  /** The constraint or unique index the database named. */
  constraint?: string
  /** The table the message names, without database or schema ('orders'). For
   *  fk_missing it is the REFERENCED table; for fk_in_use the one still linking. */
  table?: string
  /** The column the message names (fk_in_use: the linking column on `table`). */
  column?: string
  /** The duplicate key value as the database printed it — the caller's own value. */
  value?: string
}

const lastPart = (name: string): string => (name.split('.').pop() ?? name).replace(/^\[|\]$/g, '')

/** The detail behind a refusal describeDbRefusal / describeValueRefusal recognises. */
export function refusalDetail(err: unknown): DbRefusalDetail | null {
  const text = refusalText(err)
  if (!text) return null
  const fk =
    /(INSERT|UPDATE|MERGE|DELETE) statement conflicted with the (FOREIGN KEY|REFERENCE)[A-Z ]* constraint "([^"]+)"/i.exec(
      text
    )
  if (fk) {
    const removing = /^delete$/i.test(fk[1]) || /^reference$/i.test(fk[2])
    const table = /table "([^"]+)"/i.exec(text)?.[1]
    const column = /table "[^"]+", column '([^']+)'/i.exec(text)?.[1]
    return {
      kind: removing ? 'fk_in_use' : 'fk_missing',
      constraint: fk[3],
      ...(table ? { table: lastPart(table) } : {}),
      ...(column ? { column } : {})
    }
  }
  const unique =
    /Violation of (?:UNIQUE KEY|PRIMARY KEY) constraint '([^']+)'/i.exec(text) ??
    /Cannot insert duplicate key row in object '[^']+' with unique index '([^']+)'/i.exec(text)
  if (unique) {
    const table = /object '([^']+)'/i.exec(text)?.[1]
    const value = /The duplicate key value is \((.*?)\)\.?(?:\s|$|·)/i.exec(text)?.[1]
    return {
      kind: 'duplicate',
      constraint: unique[1],
      ...(table ? { table: lastPart(table) } : {}),
      ...(value !== undefined ? { value } : {})
    }
  }
  const notNull = /Cannot insert the value NULL into column '([^']+)', table '([^']+)'/i.exec(text)
  if (notNull) return { kind: 'not_null', column: notNull[1], table: lastPart(notNull[2]) }
  if (/String or binary data would be truncated/i.test(text)) {
    const col = /column '([^']+)'/i.exec(text)?.[1]
    const table = /in table '([^']+)'/i.exec(text)?.[1]
    return {
      kind: 'too_long',
      ...(col ? { column: col } : {}),
      ...(table ? { table: lastPart(table) } : {})
    }
  }
  return otherDialectDetail(text)
}

/**
 * Postgres and MySQL word the same refusals differently (the SQLSTATE / errno behind them are
 * 23503, 23505, 23502, 22001 · 1452, 1451, 1062, 1048, 1406). Read from the driver's text so a
 * caller gets the same detail on all three databases.
 */
function otherDialectDetail(text: string): DbRefusalDetail | null {
  // Postgres
  const pgFk = /violates foreign key constraint "([^"]+)"(?: on table "([^"]+)")?/i.exec(text)
  if (pgFk) {
    const removing = /update or delete on table/i.test(text)
    const refTable = /is not present in table "([^"]+)"/i.exec(text)?.[1]
    const stillIn = /is still referenced from table "([^"]+)"/i.exec(text)?.[1] ?? pgFk[2]
    const table = removing ? stillIn : refTable
    return {
      kind: removing ? 'fk_in_use' : 'fk_missing',
      constraint: pgFk[1],
      ...(table ? { table } : {})
    }
  }
  const pgUnique = /duplicate key value violates unique constraint "([^"]+)"/i.exec(text)
  if (pgUnique) {
    const value = /Key \([^)]*\)=\((.*?)\) already exists/i.exec(text)?.[1]
    return {
      kind: 'duplicate',
      constraint: pgUnique[1],
      ...(value !== undefined ? { value } : {})
    }
  }
  const pgNull =
    /null value in column "([^"]+)"(?: of relation "([^"]+)")? violates not-null/i.exec(text)
  if (pgNull)
    return { kind: 'not_null', column: pgNull[1], ...(pgNull[2] ? { table: pgNull[2] } : {}) }
  if (/value too long for type/i.test(text)) return { kind: 'too_long' }
  // MySQL
  const myFk =
    /a foreign key constraint fails \(`[^`]*`\.`([^`]+)`, CONSTRAINT `([^`]+)` FOREIGN KEY \(`([^`]+)`\) REFERENCES `([^`]+)` \(`([^`]+)`\)/i.exec(
      text
    )
  if (myFk) {
    const removing = /Cannot delete or update a parent row/i.test(text)
    return removing
      ? { kind: 'fk_in_use', constraint: myFk[2], table: myFk[1], column: myFk[3] }
      : { kind: 'fk_missing', constraint: myFk[2], table: myFk[4], column: myFk[5] }
  }
  const myDup = /Duplicate entry '(.*)' for key '([^']+)'/i.exec(text)
  if (myDup) {
    const parts = myDup[2].split('.')
    const constraint = parts.pop() as string
    return {
      kind: 'duplicate',
      constraint,
      value: myDup[1],
      ...(parts.length ? { table: parts.pop() as string } : {})
    }
  }
  const myNull =
    /Column '([^']+)' cannot be null|Field '([^']+)' doesn't have a default value/i.exec(text)
  if (myNull) return { kind: 'not_null', column: myNull[1] ?? myNull[2] }
  const myLong = /Data too long for column '([^']+)'/i.exec(text)
  if (myLong) return { kind: 'too_long', column: myLong[1] }
  // SQLite (better-sqlite3): its messages name no foreign key; knex puts the statement first,
  // so a DELETE that fails one is a parent still in use.
  if (/FOREIGN KEY constraint failed/i.test(text))
    return /^\s*delete\b/i.test(text)
      ? { kind: 'fk_in_use', constraint: 'FOREIGN KEY' }
      : { kind: 'fk_missing', constraint: 'FOREIGN KEY' }
  const slDup = /UNIQUE constraint failed: ([A-Za-z0-9_$]+)\.([A-Za-z0-9_$.,\s]+?)(?:\s*·|$)/i.exec(text)
  if (slDup) return { kind: 'duplicate', constraint: `${slDup[1]}.${slDup[2]}`, table: slDup[1] }
  const slNull = /NOT NULL constraint failed: ([A-Za-z0-9_$]+)\.([A-Za-z0-9_$]+)/i.exec(text)
  if (slNull) return { kind: 'not_null', column: slNull[2], table: slNull[1] }
  return null
}

/** The driver's messages as one string: knex/mssql wraps them in an
 *  AggregateError whose own message is only the statement. */
function refusalText(err: unknown): string {
  const e = err as { message?: unknown; detail?: unknown; errors?: Array<{ message?: unknown }> }
  // Postgres keeps the offending key in `detail` ("Key (id)=(5) is not present in table …").
  return [
    e?.message,
    typeof e?.detail === 'string' ? e.detail : undefined,
    ...(Array.isArray(e?.errors) ? e.errors.map((x) => x?.message) : [])
  ]
    .filter((m): m is string => typeof m === 'string')
    .join(' · ')
}

// The busy-pool test lives with the other "could not get a connection" shapes; importers
// keep reading it from here.
export { isPoolBusy }

export function describeDbRefusal(err: unknown): DbRefusal | null {
  const text = refusalText(err)
  if (!text) return null
  const fk =
    /(INSERT|UPDATE|MERGE|DELETE) statement conflicted with the (FOREIGN KEY|REFERENCE)[A-Z ]* constraint "([^"]+)"/i.exec(
      text
    )
  if (fk) {
    const removing = /^delete$/i.test(fk[1]) || /^reference$/i.test(fk[2])
    return removing
      ? {
          status: 409,
          code: 'RECORD_IN_USE',
          message: `Other records still link to this one (${fk[3]})`
        }
      : {
          status: 422,
          code: 'LINKED_RECORD_MISSING',
          message: `A linked record does not exist (${fk[3]})`
        }
  }
  const unique =
    /Violation of (?:UNIQUE KEY|PRIMARY KEY) constraint '([^']+)'/i.exec(text) ??
    /Cannot insert duplicate key row in object '[^']+' with unique index '([^']+)'/i.exec(text)
  if (unique) {
    return {
      status: 409,
      code: 'DUPLICATE_RECORD',
      message: `A record with these values already exists (${unique[1]})`
    }
  }
  const other = otherDialectDetail(text)
  if (other?.kind === 'fk_in_use')
    return {
      status: 409,
      code: 'RECORD_IN_USE',
      message: `Other records still link to this one (${other.constraint})`
    }
  if (other?.kind === 'fk_missing')
    return {
      status: 422,
      code: 'LINKED_RECORD_MISSING',
      message: `A linked record does not exist (${other.constraint})`
    }
  if (other?.kind === 'duplicate')
    return {
      status: 409,
      code: 'DUPLICATE_RECORD',
      message: `A record with these values already exists (${other.constraint})`
    }
  if (other?.kind === 'too_long')
    return {
      status: 422,
      code: 'VALUE_TOO_LONG',
      message: other.column
        ? `The value for ${other.column} is too long`
        : 'A value is too long for its field'
    }
  if (/String or binary data would be truncated/i.test(text)) {
    const col = /column '([^']+)'/i.exec(text)
    return {
      status: 422,
      code: 'VALUE_TOO_LONG',
      message: col ? `The value for ${col[1]} is too long` : 'A value is too long for its field'
    }
  }
  return null
}

/**
 * A conversion or overflow error from SQL Server ("Conversion failed when
 * converting the nvarchar value 'abc' to data type int", "Arithmetic
 * overflow", the driver's "must be safe integer") as a 400 — but ONLY where
 * the offending value came from the caller (the items routes, batch writes).
 * Elsewhere the same error is a server bug (a SUM that overflows, a proc
 * converting its own data) and must stay a tracked 5xx, so the global error
 * handler never uses this.
 */
export function describeValueRefusal(err: unknown): DbRefusal | null {
  const text = refusalText(err)
  if (!text) return null
  if (
    /Conversion failed when converting|Error converting data type|Operand type clash|invalid input syntax for type|invalid input value for enum|Incorrect (integer|decimal|double|float|datetime|date|time|string) value|Truncated incorrect|date\/time field value out of range/i.test(
      text
    )
  ) {
    return {
      status: 400,
      code: 'VALUE_TYPE_MISMATCH',
      message: "A value does not match its field's type"
    }
  }
  // 515: a column that needs a value got none — on a create, a field the
  // caller left out. Only where the row came from the caller (see above).
  const notNull =
    /Cannot insert the value NULL into column '([^']+)'/i.exec(text) ??
    /null value in column "([^"]+)"/i.exec(text) ??
    /Column '([^']+)' cannot be null/i.exec(text) ??
    /Field '([^']+)' doesn't have a default value/i.exec(text) ??
    /NOT NULL constraint failed: [A-Za-z0-9_$]+\.([A-Za-z0-9_$]+)/i.exec(text)
  if (notNull || /Cannot insert the value NULL into column/i.test(text)) {
    return {
      status: 422,
      code: 'REQUIRED_VALUE_MISSING',
      message: notNull ? `${notNull[1]} needs a value` : 'A required value is missing'
    }
  }
  if (
    /Arithmetic overflow error|must be safe integer|Value must be between -?\d+ and -?\d+|is out of range for type|numeric field overflow|integer out of range|Out of range value for column/i.test(
      text
    )
  ) {
    return {
      status: 400,
      code: 'VALUE_OUT_OF_RANGE',
      message: 'A number is too large or too small for its field'
    }
  }
  return null
}

/**
 * The message a 5xx body may carry: the driver's reason without the statement
 * that raised it (knex prefixes the SQL — after a `field[0]: ` label on a
 * nested write; an AggregateError keeps the reasons in `.errors`). Table
 * names, columns and bound values stay in the log.
 */
export function messageWithoutSql(err: unknown): string {
  const e = err as { message?: unknown; errors?: unknown }
  const message = typeof e?.message === 'string' ? e.message : String(err)
  const head = SQL_HEAD.exec(message)
  if (!head) return message
  const inner = Array.isArray(e?.errors)
    ? e.errors
        .map((x) => (x instanceof Error ? x.message : typeof x === 'string' ? x : ''))
        .map((m) => m.trim())
        .filter(Boolean)
    : []
  const cut = message.lastIndexOf(' - ')
  const statement = cut > 0 ? message.slice(0, cut) : message
  // knex brackets identifiers and numbers its bindings; a hand-written or
  // driver statement still reads as SQL (from / into / set / where …). Plain
  // prose that happens to start with "Update …" is left alone.
  const looksLikeSql =
    /\[[^\]]+\]|@p\d/.test(statement) ||
    (cut > 0 && /\b(from|into|set|where|values|join|exec|execute|table)\b/i.test(statement))
  if (!looksLikeSql) return message
  if (inner.length > 0) return `${head[1]}${[...new Set(inner)].slice(0, 3).join(' · ')}`
  return `${head[1]}${cut > 0 ? message.slice(cut + 3) : 'The database refused the statement'}`
}

/** What a 5xx body says for a database fault (see serverFaultMessage). */
export const DB_FAULT_MESSAGE =
  'The server could not finish this request. The problem was recorded; try again, or ask for help if it keeps happening.'

/**
 * Whether an error came from the database driver: a statement knex prefixed (the driver's
 * reason after it), a tedious RequestError (`number`, `EREQUEST`), a connection that would
 * not open, or an AggregateError of them.
 */
export function isDriverFault(err: unknown): boolean {
  const e = err as {
    message?: unknown
    number?: unknown
    code?: unknown
    errors?: unknown
    statusCode?: unknown
  }
  if (!e || typeof e !== 'object') return false
  // An error that carries its own status is ours (LIST_TIMEOUT, a coded refusal).
  if (e.statusCode != null) return false
  const message = typeof e.message === 'string' ? e.message : ''
  // A connection that would not open or was dropped (tedious ConnectionError): its message
  // names the database login ("Login failed for user '…'") or the server's host and port.
  // Told by the driver's error code first, never by the words alone: a mail server says
  // "Login failed" and a partner call "Failed to connect to …" too (lib/db-unavailable.ts,
  // the one classifier). A statement timeout shares the ETIMEOUT code and stays readable
  // (the log lenses read it).
  if (isConnectFailure(err)) return true
  if (message && messageWithoutSql(err) !== message) return true
  if (typeof e.number === 'number' || e.code === 'EREQUEST') return true
  // Postgres (a SQLSTATE `code` + `severity`) and MySQL (`errno` + `sqlState`) driver errors.
  const x = e as { severity?: unknown; errno?: unknown; sqlState?: unknown }
  if (
    typeof e.code === 'string' &&
    typeof x.severity === 'string' &&
    /^\d[0-9A-Z]{4}$/.test(e.code)
  )
    return true
  if (typeof x.errno === 'number' && typeof x.sqlState === 'string') return true
  return (
    Array.isArray(e.errors) &&
    e.errors.some(
      (x) =>
        !!x &&
        typeof x === 'object' &&
        (typeof (x as { number?: unknown }).number === 'number' ||
          (x as { code?: unknown }).code === 'EREQUEST')
    )
  )
}

/**
 * The message a 5xx body carries. A database fault never shows the driver's own words
 * ("Ambiguous column name 'id'." named the columns of a broken statement to every caller,
 * army 7 b15): a plain sentence instead, the reason stays in the log and the issue.
 * Anything else keeps messageWithoutSql.
 */
export function serverFaultMessage(err: unknown): string {
  return isDriverFault(err) ? DB_FAULT_MESSAGE : messageWithoutSql(err)
}

const SQL_HEAD =
  /^((?:[^:\n]{1,80}: )?)(?:insert|update|delete|select|merge|exec|execute|with|declare)\s/i

/** The reason of a driver error, without the statement that raised it. */
export function reasonWithoutSql(message: string): string {
  const cut = message.lastIndexOf(' - ')
  return /^(insert|update|delete|select|merge|exec|with)\b/i.test(message) && cut > 0
    ? message.slice(cut + 3)
    : message
}

/**
 * An error as text worth keeping. knex/mssql rejects with an AggregateError
 * whose own message is only the statement; the reason sits in `.errors`. The
 * reason comes first, the statement after it, shortened.
 */
export function errorText(err: unknown, max = 2000): string {
  if (!(err instanceof Error)) return String(err).slice(0, max)
  const inner = (err as { errors?: unknown }).errors
  const reasons = Array.isArray(inner)
    ? [
        ...new Set(
          inner
            .map((e) => (e instanceof Error ? e.message : String(e)))
            .map((m) => m.trim())
            .filter(Boolean)
        )
      ]
    : []
  const head = (err.message ?? '').replace(/\s+-\s*$/, '').trim()
  if (reasons.length === 0) return (head || err.name || 'Error').slice(0, max)
  const shown = reasons.slice(0, 5)
  const more = reasons.length > shown.length ? ` (+${reasons.length - shown.length} more)` : ''
  const statement = head
    ? ` — while running: ${head.slice(0, 300)}${head.length > 300 ? '…' : ''}`
    : ''
  return `${shown.join(' · ')}${more}${statement}`.slice(0, max)
}
