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
