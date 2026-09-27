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
  code: 'LINKED_RECORD_MISSING' | 'RECORD_IN_USE' | 'DUPLICATE_RECORD' | 'VALUE_TOO_LONG'
  message: string
}

export function describeDbRefusal(err: unknown): DbRefusal | null {
  const e = err as { message?: unknown; number?: unknown; errors?: Array<{ message?: unknown }> }
  // knex/mssql wraps the driver's messages in an AggregateError whose own
  // message is only the statement.
  const text = [e?.message, ...(Array.isArray(e?.errors) ? e.errors.map((x) => x?.message) : [])]
    .filter((m): m is string => typeof m === 'string')
    .join(' · ')
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
