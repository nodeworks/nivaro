import type { Knex } from 'knex'
import { db } from '../db/index.js'

/**
 * Long-running and multi-statement SQL, outside knex.raw's two limits.
 *
 * 1. TIMEOUT. knex.raw rides tedious' connection-level requestTimeout (15s).
 *    Past it tedious sends an attention and the batch is cancelled mid-flight:
 *    an index build over a big table, a bulk load or an import procedure never
 *    fits. `runLongSql` gives ONE statement its own request timeout — none by
 *    default, a budget when the caller is answering a request — instead of
 *    raising the global one for every query in the process.
 *
 * 2. SCOPE. knex.raw sends every statement through sp_executesql, which gives
 *    a #temp table its own scope and DROPS it on return — so a temp table can
 *    never span two knex.raw calls, even inside one transaction. A script that
 *    fills #ids in one call and reads it in the next silently reads nothing.
 *    `withLongConnection` pins one connection and runs plain batches on it
 *    (execSqlBatch, no sp_executesql wrapper), so #temp tables, SET options
 *    and an open transaction all survive from one `run` to the next.
 *
 * Neither form binds parameters: a batch is sent as text. Callers interpolate
 * only values they built themselves (validated identifiers, numbers) — never
 * request input. Other dialects have neither limit and fall through to raw.
 */

/**
 * Twenty minutes — the cron budget (Rob, 2026-09-21). A nightly proc over
 * sixteen million activity rows, an index build or a redaction sweep runs to
 * completion inside it; anything still going at twenty minutes is stuck, not
 * slow, and cancelling it beats holding a pool connection till morning.
 * Callers on a request path pass their own, shorter budget; 0 = no timeout.
 */
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000

export interface RunLongOptions {
  /** Request timeout for this statement. Default 20 minutes; 0 = none. */
  timeoutMs?: number
  /** Knex instance to borrow the connection from. Default the app's. */
  knex?: Knex
}

export interface LongConnection {
  /** Run one batch on the pinned connection; resolves with its rows. */
  run<T = Record<string, unknown>>(sql: string, timeoutMs?: number): Promise<T[]>
}

interface TediousColumn {
  metadata: { colName: string }
  value: unknown
}

interface TediousRequest {
  on(ev: 'row', h: (cols: TediousColumn[]) => void): unknown
  on(ev: 'error', h: (e: Error) => void): unknown
  once(ev: 'requestCompleted', h: () => void): unknown
  setTimeout?: (ms: number) => void
}

// biome-ignore lint/suspicious/noExplicitAny: internal Knex/tedious plumbing
function clientOf(knex: Knex): any {
  // biome-ignore lint/suspicious/noExplicitAny: internal Knex/tedious plumbing
  return (knex as any).client
}

function isMssqlClient(knex: Knex): boolean {
  return clientOf(knex).config?.client === 'mssql'
}

function execBatch<T>(
  // biome-ignore lint/suspicious/noExplicitAny: tedious driver namespace
  driver: any,
  conn: { execSqlBatch(r: unknown): void },
  sql: string,
  timeoutMs: number
): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const rows: T[] = []
    let settled = false
    const done = (fn: () => void) => {
      if (!settled) {
        settled = true
        fn()
      }
    }
    const req = new driver.Request(sql, (err: Error | null) => {
      if (err) done(() => reject(err))
    }) as TediousRequest
    req.setTimeout?.(timeoutMs)
    req.on('row', (cols) => {
      const row: Record<string, unknown> = {}
      for (const c of cols) row[c.metadata.colName] = c.value
      rows.push(row as T)
    })
    req.once('requestCompleted', () => done(() => resolve(rows)))
    req.on('error', (e) => done(() => reject(e)))
    conn.execSqlBatch(req)
  })
}

/**
 * Pin one connection for the life of `fn`. Every `run` is a plain batch on
 * that connection, so session state carries across calls.
 */
export async function withLongConnection<R>(
  fn: (conn: LongConnection) => Promise<R>,
  opts: RunLongOptions = {}
): Promise<R> {
  const knex = opts.knex ?? (db as unknown as Knex)
  const fallback = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  if (!isMssqlClient(knex)) {
    // One transaction = one connection on every other dialect.
    return knex.transaction(async (trx) =>
      fn({
        async run<T>(sql: string) {
          const res = await trx.raw(sql)
          return (Array.isArray(res) ? res : (res?.rows ?? [])) as T[]
        }
      })
    )
  }

  const client = clientOf(knex)
  const driver = client._driver()
  const conn = (await client.acquireConnection()) as { execSqlBatch(r: unknown): void }
  try {
    return await fn({
      run: <T>(sql: string, timeoutMs?: number) =>
        execBatch<T>(driver, conn, sql, timeoutMs ?? fallback)
    })
  } finally {
    // A batch that threw between BEGIN TRAN and COMMIT would hand the pool a
    // connection still inside a transaction, holding its locks for the next
    // caller. Never let that leave this function.
    await execBatch(driver, conn, 'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION', 30_000).catch(
      () => undefined
    )
    await client.releaseConnection(conn)
  }
}

/** One statement with its own request timeout. Resolves with its rows. */
export async function runLongSql<T = Record<string, unknown>>(
  sql: string,
  opts: RunLongOptions = {}
): Promise<T[]> {
  return withLongConnection((c) => c.run<T>(sql), opts)
}
