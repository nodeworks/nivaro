import type { Knex } from 'knex'

/**
 * True when this knex speaks SQL Server. Migrations use it to guard T-SQL-only
 * statements (sys.* catalog reads, runLongSql index builds, NVARCHAR(MAX) raw
 * DDL) so a Postgres / MySQL tenant skips them instead of failing — checked by
 * `pnpm lint:traps` (#757).
 */
export function isMssql(knex: Knex): boolean {
  // biome-ignore lint/suspicious/noExplicitAny: knex does not type client.config
  return (knex as any)?.client?.config?.client === 'mssql'
}

/**
 * The database's current UTC time, for column defaults in new migrations
 * (#749). knex.fn.now() compiles to the server's LOCAL clock on SQL Server,
 * while the API writes JS UTC — one column ends up holding two clocks.
 */
export function utcNow(knex: Knex): Knex.Raw {
  // biome-ignore lint/suspicious/noExplicitAny: knex does not type client.config
  const client = (knex as any)?.client?.config?.client
  if (client === 'mssql') return knex.raw('GETUTCDATE()')
  if (client === 'pg' || client === 'postgres' || client === 'postgresql')
    return knex.raw("(now() at time zone 'utc')")
  if (client === 'mysql' || client === 'mysql2') return knex.raw('(UTC_TIMESTAMP())')
  return knex.fn.now()
}
