import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Knex } from 'knex'
import { db } from '../index.js'
import { rawRows } from '../raw-rows.js'
import { sqlDialect, statementTimeoutResetSql, statementTimeoutSql } from '../sql-dialect.js'

/**
 * Features that only exist on SQL Server (DMVs, Query Store, T-SQL procedures, msdb backups,
 * SQL checks over sys.sql_modules, database tuning) and the plumbing that runs customer SQL
 * text on Postgres / MySQL.
 *
 * Ruling (phase 2): on Postgres / MySQL a SQL Server-only route answers 501
 * NOT_SUPPORTED_ON_DATABASE; crons, readiness checks and background jobs skip quietly.
 */

export const NOT_SUPPORTED_ON_DATABASE = 'NOT_SUPPORTED_ON_DATABASE'
export const NEEDS_SQL_SERVER = 'This needs a SQL Server database.'

/**
 * True when the database this request / job runs on is SQL Server (tenant-aware via `db`).
 * A knex whose client is unknown counts as SQL Server (sqlDialect's default), so unit-test
 * doubles keep the SQL Server path.
 */
export function onSqlServer(knex?: Knex): boolean {
  return sqlDialect(knex ?? (db as unknown as Knex)) === 'mssql'
}

export function needsSqlServerBody(): { error: string; code: string } {
  return { error: NEEDS_SQL_SERVER, code: NOT_SUPPORTED_ON_DATABASE }
}

/** 501 with the ruling's body. */
export function replyNeedsSqlServer(reply: FastifyReply): FastifyReply {
  return reply.code(501).send(needsSqlServerBody())
}

/** preHandler for a route / plugin that is SQL Server-only: 501 elsewhere. */
export async function requireSqlServer(
  _req: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply | undefined> {
  if (!onSqlServer()) return replyNeedsSqlServer(reply)
  return undefined
}

/** A readiness result for a SQL Server-only check on another database. */
export function skipNeedsSqlServer(what: string): { status: 'skip'; detail: string } {
  return { status: 'skip', detail: `${what} needs a SQL Server database` }
}

/** A thrown refusal callers turn into the 501 (statusCode + code ride along). */
export class NotSupportedOnDatabaseError extends Error {
  statusCode = 501
  code = NOT_SUPPORTED_ON_DATABASE
  constructor(message = NEEDS_SQL_SERVER) {
    super(message)
  }
}

type DriverConn = any

/** Rows of a driver result: pg Result | Result[] (several statements); mysql2 rows | [rows…]. */
function driverRows<T>(dialect: 'pg' | 'mysql', res: unknown): T[] {
  if (dialect === 'pg') {
    const parts = Array.isArray(res) ? res : [res]
    return parts.flatMap((p) => ((p as { rows?: T[] } | null)?.rows ?? []) as T[])
  }
  if (!Array.isArray(res)) return []
  // several statements: one entry per statement (rows array, or a result header)
  const multi = res.length > 0 && res.every((r) => Array.isArray(r) || isHeader(r))
  if (multi) return res.flatMap((r) => (Array.isArray(r) ? (r as T[]) : []))
  return res as T[]
}

function isHeader(r: unknown): boolean {
  return (
    !!r &&
    typeof r === 'object' &&
    !Array.isArray(r) &&
    'affectedRows' in (r as object) &&
    'fieldCount' in (r as object)
  )
}

/**
 * Run SQL TEXT as written on Postgres / MySQL — straight through the driver, so a `?` in the
 * text is never read as a placeholder (knex would) — on one pinned connection with a statement
 * timeout (`statement_timeout` / `max_execution_time`, MySQL bounds SELECTs only). A
 * transaction the text left open is rolled back and the session timeout reset before the
 * connection returns to the pool. Rows of every statement, in order (SQL Server's batch shape).
 * Never pass request input inside `sql`: values are literals the caller built safely.
 */
export async function runSqlText<T = Record<string, unknown>>(
  knex: Knex,
  sql: string,
  opts: { timeoutMs?: number } = {}
): Promise<T[]> {
  const dialect = sqlDialect(knex)
  if (dialect === 'mssql') return rawRows<T>(await knex.raw(sql))
  // SQLite: one process, one file, no session timeout; knex.raw without bindings keeps a `?`.
  if (dialect === 'sqlite') return rawRows<T>(await knex.raw(sql))
  const client = (knex as any).client
  const conn = (await client.acquireConnection()) as DriverConn
  const q = (text: string) =>
    new Promise<unknown>((resolve, reject) => {
      conn.query(text, (err: Error | null, res: unknown) => (err ? reject(err) : resolve(res)))
    })
  const ms = Math.max(0, Math.trunc(Number(opts.timeoutMs) || 0))
  try {
    await q(statementTimeoutSql(knex, ms))
    return driverRows<T>(dialect, await q(sql))
  } finally {
    await q('ROLLBACK').catch(() => undefined)
    const reset = statementTimeoutResetSql(knex)
    await q(reset).catch(() => {
      conn.__knex__disposed = 'session reset failed'
    })
    await client.releaseConnection(conn)
  }
}
