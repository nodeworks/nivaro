import type { Knex } from 'knex'

export function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be positive')
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

export async function selectInChunks<T, I = string | number>(
  ids: I[],
  chunkSize: number,
  queryFn: (chunk: I[]) => Promise<T[]>
): Promise<T[]> {
  if (ids.length === 0) return []
  const chunks = chunkArray(ids, chunkSize)
  const results = await Promise.all(chunks.map((chunk) => queryFn(chunk)))
  return results.flat()
}

/** At or above this many ids, `whereInList` sends one OPENJSON parameter on SQL Server. */
export const JSON_LIST_MIN = 50

/**
 * `column IN (ids)` for an id list that can run long. On SQL Server a list of
 * N parameters is a new statement text per N, so each length compiles a fresh
 * plan (240–850 ms for 700–1,300 ids on busy staging, 2026-10-30 zone pulse)
 * and ships every value as its own parameter. From JSON_LIST_MIN ids it binds
 * ONE JSON array and reads it with OPENJSON — one cached plan for every
 * length, ~10 ms server time. Same rows: each value converts to the column's
 * type exactly as a bound parameter does; null ids are dropped (`IN (NULL)`
 * never matches). Other dialects, and short lists, keep the plain whereIn.
 */
export function whereInList<Q extends Knex.QueryBuilder>(
  qb: Q,
  column: string,
  ids: ReadonlyArray<string | number | null | undefined>
): Q {
  const dialect = String(
    (qb as unknown as { client?: { config?: { client?: unknown } } }).client?.config?.client ?? ''
  )
  if (ids.length < JSON_LIST_MIN || !/mssql/i.test(dialect))
    return qb.whereIn(column, ids as never) as Q
  const values = ids.filter((v) => v != null).map(String)
  return qb.whereRaw('?? IN (SELECT [value] FROM OPENJSON(?))', [
    column,
    JSON.stringify(values)
  ]) as Q
}
