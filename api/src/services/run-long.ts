import type { Knex } from 'knex'
import { resolveDb } from '../db/index.js'
import { rawRows } from '../db/raw-rows.js'
import { bumpAccessVersion, notePermissionStatement } from './permission-cache.js'

/** Pinned connections a batch with a possible access write ran on (permission cache). */
const touched = new WeakSet<object>()

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
  /** Low-level: run a request of your own on the pinned connection (runLongQuery). */
  runWith<T>(
    exec: (driver: any, conn: unknown, timeoutMs: number) => Promise<T[]>,
    timeoutMs?: number
  ): Promise<T[]>
  /**
   * The session can no longer be trusted (a SET … OFF failed, a ROLLBACK did not run): close
   * it when `fn` returns instead of handing it back to the pool. The server rolls back whatever
   * it still holds; the pool sees it disconnected and destroys it. No-op on other dialects.
   */
  discard(): void
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
    req.once('requestCompleted', () =>
      done(() => {
        notePermissionStatement(sql, true)
        resolve(rows)
      })
    )
    req.on('error', (e) =>
      done(() => {
        notePermissionStatement(sql, true)
        reject(e)
      })
    )
    // A raw batch reaches no knex event: the permission cache hears it here.
    if (notePermissionStatement(sql, false)) touched.add(conn)
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
  // Resolved once: the pool this context runs on (#1321 — background work
  // pins a connection from the background pool), kept for acquire + release.
  const knex = opts.knex ?? (resolveDb() as unknown as Knex)
  const fallback = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  if (!isMssqlClient(knex)) {
    // One transaction = one connection on every other dialect.
    return knex.transaction(async (trx) =>
      fn({
        async run<T>(sql: string) {
          const res = await trx.raw(sql)
          return rawRows<T>(res)
        },
        runWith() {
          throw new Error('runWith needs SQL Server')
        },
        discard() {}
      })
    )
  }

  const client = clientOf(knex)
  const driver = client._driver()
  const conn = (await client.acquireConnection()) as TediousConnection
  let discarded = false
  try {
    return await fn({
      run: <T>(sql: string, timeoutMs?: number) =>
        execBatch<T>(driver, conn, sql, timeoutMs ?? fallback),
      runWith: <T>(
        exec: (driver: any, conn: unknown, timeoutMs: number) => Promise<T[]>,
        timeoutMs?: number
      ) => exec(driver, conn, timeoutMs ?? fallback),
      discard: () => {
        discarded = true
      }
    })
  } finally {
    if (discarded) {
      await closeConnection(conn)
    } else {
      // A batch that threw between BEGIN TRAN and COMMIT would hand the pool a
      // connection still inside a transaction, holding its locks for the next
      // caller. Never let that leave this function.
      await execBatch(driver, conn, 'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION', 30_000).catch(
        () => undefined
      )
    }
    await client.releaseConnection(conn)
    // Batches on this connection may have held a transaction across calls (BEGIN … COMMIT):
    // it has ended now, whichever way.
    if (touched.delete(conn)) bumpAccessVersion()
  }
}

interface TediousConnection {
  execSqlBatch(r: unknown): void
  close(): void
  once(ev: 'end', h: () => void): unknown
  closed?: boolean
  connected?: boolean
}

/**
 * Close the socket now, so the server ends the session (and its transaction, locks and SET
 * state) at once, and mark it disconnected: knex's pool validation then destroys it rather
 * than handing it to the next caller.
 */
async function closeConnection(conn: TediousConnection): Promise<void> {
  conn.connected = false
  if (conn.closed) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000)
    conn.once('end', () => {
      clearTimeout(timer)
      resolve()
    })
    try {
      conn.close()
    } catch {
      clearTimeout(timer)
      resolve()
    }
  })
}

/** One statement with its own request timeout. Resolves with its rows. */
export async function runLongSql<T = Record<string, unknown>>(
  sql: string,
  opts: RunLongOptions = {}
): Promise<T[]> {
  return withLongConnection((c) => c.run<T>(sql), opts)
}

/** A knex-style `?` binding turned into a typed tedious parameter. */
function addTediousParam(driver: any, req: any, name: string, v: unknown): void {
  const T = driver.TYPES
  if (v instanceof Date) req.addParameter(name, T.DateTime2, v, { scale: 7 })
  else if (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) < 2 ** 31)
    req.addParameter(name, T.Int, v)
  else if (typeof v === 'number') req.addParameter(name, T.Float, v)
  else if (typeof v === 'boolean') req.addParameter(name, T.Bit, v)
  else req.addParameter(name, T.NVarChar, v == null ? null : String(v), { length: 'max' })
}

/**
 * One PARAMETERISED statement with its own request timeout — `runLongSql` for a
 * read that binds values (request input never goes into the text). `?` marks a
 * binding exactly as knex.raw does; the SQL must hold no other `?` (no literal
 * question marks in strings). Other dialects run it through knex.raw.
 */
export async function runLongQuery<T = Record<string, unknown>>(
  sql: string,
  bindings: unknown[],
  opts: RunLongOptions = {}
): Promise<T[]> {
  const knex = opts.knex ?? (resolveDb() as unknown as Knex)
  if (!isMssqlClient(knex)) {
    const res = await knex.raw(sql, bindings as never)
    return rawRows<T>(res)
  }
  const parts = sql.split('?')
  if (parts.length - 1 !== bindings.length)
    throw new Error(
      `runLongQuery: ${parts.length - 1} placeholders for ${bindings.length} bindings`
    )
  const text = parts.reduce((acc, p, i) => (i === 0 ? p : `${acc}@p${i - 1}${p}`), '')
  return withLongConnection(
    (c) =>
      c.runWith<T>((driver, conn, timeoutMs) => {
        return new Promise<T[]>((resolve, reject) => {
          const rows: T[] = []
          let settled = false
          const done = (fn: () => void) => {
            if (!settled) {
              settled = true
              fn()
            }
          }
          const req = new driver.Request(text, (err: Error | null) => {
            if (err) done(() => reject(err))
          }) as TediousRequest & { addParameter: unknown }
          req.setTimeout?.(timeoutMs)
          for (const [i, b] of bindings.entries()) addTediousParam(driver, req, `p${i}`, b)
          req.on('row', (cols) => {
            const row: Record<string, unknown> = {}
            for (const col of cols) row[col.metadata.colName] = col.value
            rows.push(row as T)
          })
          req.once('requestCompleted', () => done(() => resolve(rows)))
          req.on('error', (e) => done(() => reject(e)))
          ;(conn as unknown as { execSql(r: unknown): void }).execSql(req)
        })
      }),
    opts
  )
}
