import type { Knex } from 'knex'

/**
 * Cross-dialect helpers for the traffic / telemetry / integrations area (phase 2, bucket D).
 */

/**
 * Delete at most `n` rows of `table` that `scope` selects (the id list is picked first, then
 * deleted by id), returning how many went. For Postgres and MySQL, where `DELETE TOP (n)` does
 * not exist and MySQL refuses LIMIT inside an IN subquery (the id list goes through a derived
 * table). SQL Server callers keep their own `DELETE TOP (n) …; SELECT @@ROWCOUNT` batch.
 */
export async function deleteBatch(
  knex: Knex,
  table: string,
  n: number,
  scope: (q: Knex.QueryBuilder) => Knex.QueryBuilder,
  idCol = 'id'
): Promise<number> {
  const picked = scope(knex(table).select(idCol)).limit(Math.max(1, Math.floor(n)))
  const affected = await knex(table)
    .whereIn(idCol, knex.select(idCol).from(picked.as('nvr_batch')))
    .del()
  return Number(affected) || 0
}

/** `col` truncated to the start of its hour, as a datetime (SQL Server: DATEADD(hour, DATEDIFF(hour, 0, col), 0)). */
export function hourBucket(knex: Knex, col: string): string {
  const c = String((knex as any)?.client?.config?.client ?? '')
  if (c === 'pg' || c === 'postgres' || c === 'postgresql') return `date_trunc('hour', ${col})`
  if (c === 'mysql' || c === 'mysql2') return `DATE_ADD(DATE(${col}), INTERVAL HOUR(${col}) HOUR)`
  return `DATEADD(hour, DATEDIFF(hour, 0, ${col}), 0)`
}

/**
 * Join `nivaro_users` on a request-log user column. The log stores the person as text
 * (varchar on Postgres / MySQL), the users table keys on a uuid: Postgres refuses `uuid = varchar`,
 * so it compares as lower-case text. SQL Server and MySQL keep the plain equality.
 */
export function joinLogUser<T extends Knex.QueryBuilder>(
  knex: Knex,
  qb: T,
  logCol = 'l.user',
  alias = 'u',
  kind: 'left' | 'inner' = 'left'
): T {
  const c = String((knex as any)?.client?.config?.client ?? '')
  const table = `nivaro_users as ${alias}`
  const fn = kind === 'left' ? 'leftJoin' : 'join'
  if (c === 'pg' || c === 'postgres' || c === 'postgresql') {
    void qb[fn](table, function (this: Knex.JoinClause) {
      this.on(
        knex.raw('LOWER(CAST(?? AS TEXT)) = LOWER(CAST(?? AS TEXT))', [`${alias}.id`, logCol])
      )
    })
  } else void qb[fn](table, `${alias}.id`, logCol)
  return qb
}

/** A `?` binding that Postgres can type inside CONCAT(…) (an untyped parameter there is an error). */
export function textParam(knex: Knex): string {
  const c = String((knex as any)?.client?.config?.client ?? '')
  return c === 'pg' || c === 'postgres' || c === 'postgresql' ? '?::text' : '?'
}

/**
 * Join `table` on `uuidCol` (a uuid column, e.g. `i.id`) = `textCol` (a varchar holding a uuid).
 * Postgres refuses `uuid = varchar`, so it compares lower-case text; the others keep plain equality.
 */
export function joinUuidToText<T extends Knex.QueryBuilder>(
  knex: Knex,
  qb: T,
  table: string,
  uuidCol: string,
  textCol: string,
  kind: 'left' | 'inner' = 'inner'
): T {
  const c = String((knex as any)?.client?.config?.client ?? '')
  const fn = kind === 'left' ? 'leftJoin' : 'join'
  if (c === 'pg' || c === 'postgres' || c === 'postgresql') {
    void qb[fn](table, function (this: Knex.JoinClause) {
      this.on(knex.raw('LOWER(CAST(?? AS TEXT)) = LOWER(CAST(?? AS TEXT))', [uuidCol, textCol]))
    })
  } else void qb[fn](table, uuidCol, textCol)
  return qb
}
