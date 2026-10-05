import { db } from '../db/index.js'

/**
 * Is this table / procedure a transactional-replication article whose DDL forwards to
 * subscribers (replicate_ddl = 1)? Production is a publisher; dev and staging are not.
 * False on every other dialect and on a database without the replication tables.
 * Only a successful lookup is cached: a failed query returns false uncached so it retries.
 */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const TTL = 10 * 60_000
const cache = new Map<string, { at: number; value: boolean }>()

function isMssql(): boolean {
  // biome-ignore lint/suspicious/noExplicitAny: knex does not type client.config
  return (db as any)?.client?.config?.client === 'mssql'
}

async function lookup(key: string, sql: string, name: string): Promise<boolean> {
  if (!IDENT.test(name)) return false
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.value
  if (!isMssql()) {
    cache.set(key, { at: Date.now(), value: false })
    return false
  }
  try {
    const rows = (await db.raw(sql, [name])) as Array<{ n: number }>
    const value = Number(rows?.[0]?.n ?? 0) > 0
    cache.set(key, { at: Date.now(), value })
    return value
  } catch {
    return false
  }
}

/** Table articles: sysarticles.type 1/3/5/7 (log-based, indexed view, etc.). */
export function isReplicatedArticle(table: string): Promise<boolean> {
  return lookup(
    `t:${table}`,
    `SELECT COUNT(*) AS n FROM dbo.sysarticles a JOIN dbo.syspublications p ON p.pubid = a.pubid
      WHERE a.name = ? AND a.type IN (1, 3, 5, 7) AND p.replicate_ddl = 1`,
    table
  )
}

/** Procedure articles: type 8 (proc execution), 24 (serializable proc), 32 (schema-only proc). */
export function isReplicatedProcedure(name: string): Promise<boolean> {
  return lookup(
    `p:${name}`,
    `SELECT COUNT(*) AS n FROM dbo.sysarticles a JOIN dbo.syspublications p ON p.pubid = a.pubid
      WHERE a.name = ? AND a.type IN (8, 24, 32) AND p.replicate_ddl = 1`,
    name
  )
}

export function bustReplicationCache(): void {
  cache.clear()
}
