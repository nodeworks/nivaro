// Postgres times as UTC, like SQL Server (tedious useUTC) and MySQL (timezone 'Z').
//
// node-postgres reads `timestamp without time zone` and `date` values as LOCAL time and sends
// JS Dates as local time, so on a machine outside UTC every such value moved by the machine's
// offset (a test API in New York read 10:20 back as 14:20). The app writes and compares UTC
// everywhere, so:
//  - timestamp (OID 1114) is read as UTC; date (1082) as UTC midnight, the same Date SQL Server
//    and MySQL hand back for a date column;
//  - Dates sent as parameters are written as UTC;
//  - each connection's session runs in UTC (see pgSessionUtc), so now() and timestamptz output
//    are UTC too.
// Process-wide and idempotent; it changes only the pg driver. A server already in UTC (cloud
// containers) sees no difference.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let done = false

export function pgUtc(): void {
  if (done) return
  done = true
  let pg: any
  try {
    pg = require('pg')
  } catch {
    return // pg not installed: nothing to configure
  }
  const types = pg.types ?? pg.default?.types
  types.setTypeParser(1114, (s: string) => (s == null ? s : new Date(`${s.replace(' ', 'T')}Z`)))
  types.setTypeParser(1082, (s: string) => (s == null ? s : new Date(`${s}T00:00:00Z`)))
  const defaults = pg.defaults ?? pg.default?.defaults
  if (defaults) defaults.parseInputDatesAsUTC = true
}

/** Pool `afterCreate` for Postgres: the session runs in UTC. */
export function pgSessionUtc(
  conn: { query: (sql: string, cb: (err: Error | null) => void) => void },
  done: (err: Error | null, c: unknown) => void
): void {
  conn.query("SET TIME ZONE 'UTC'", (err) => done(err, conn))
}
