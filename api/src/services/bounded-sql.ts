import type { Knex } from 'knex'
import { resolveDb } from '../db/index.js'

/**
 * One read statement with its own deadline that the SERVER honours: when the
 * time is up (or `signal` aborts) the statement is cancelled on SQL Server (a
 * TDS attention) and its connection goes back to the pool at once, instead of
 * scanning on for seconds after the caller stopped waiting. Search uses it to
 * give every collection a time budget (routes/global-search.ts).
 *
 * Bindings are bound like knex.raw (`?` placeholders, never inlined). Rows come
 * back as plain objects keyed by column name. Read statements only: there is no
 * transaction handling, and a statement is never retried.
 *
 * Other dialects: knex.raw, abandoned (not cancelled) at the deadline.
 */

export class StatementCancelled extends Error {
  constructor(readonly reason: 'timeout' | 'aborted') {
    super(reason === 'timeout' ? 'Statement passed its time budget' : 'Statement cancelled')
  }
}

interface TediousColumn {
  metadata: { colName: string }
  value: unknown
}

interface TediousRequest {
  on(ev: 'row', h: (cols: TediousColumn[]) => void): unknown
  setTimeout?: (ms: number) => void
}

interface TediousConnection {
  execSql(r: unknown): void
  cancel(): boolean
  close(): void
  closed?: boolean
  connected?: boolean
}

type KnexClient = any

/** Bounded statements never pass knex's query events: a tracer (tests, benches) can
 *  listen here. Called once per statement with its outcome. */
export const boundedSqlObserver: {
  fn:
    | ((e: {
        sql: string
        bindings: readonly unknown[]
        ms: number
        rows: number
        error?: string
      }) => void)
    | null
} = { fn: null }

function isMssql(client: KnexClient): boolean {
  return client?.config?.client === 'mssql'
}

/** How long past its deadline a cancelled statement may take to hand its connection back. */
const CANCEL_GRACE_MS = 5_000

export async function boundedRaw<T = Record<string, unknown>>(
  sql: string,
  bindings: readonly unknown[],
  opts: {
    timeoutMs: number
    signal?: AbortSignal
    knex?: Knex
    /** `sql` is already in the driver's form (`@p0`…, from `toSQL().toNative()`). */
    native?: boolean
  }
): Promise<T[]> {
  const knex = opts.knex ?? (resolveDb() as unknown as Knex)
  if (opts.signal?.aborted) throw new StatementCancelled('aborted')
  const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs))
  const client: KnexClient = (knex as unknown as { client: KnexClient }).client
  if (!isMssql(client)) {
    if (opts.native) throw new Error('native SQL is SQL Server only')
    return raceOther<T>(knex, sql, bindings, timeoutMs, opts.signal)
  }

  const started = performance.now()
  const note = (rows: number, error?: string) =>
    boundedSqlObserver.fn?.({ sql, bindings, ms: performance.now() - started, rows, error })
  const native = opts.native
    ? { sql, bindings: bindings as unknown[] }
    : knex
        .raw(sql, bindings as never)
        .toSQL()
        .toNative()
  const driver = client._driver()
  const conn = (await client.acquireConnection()) as TediousConnection
  let broken = false
  try {
    return await new Promise<T[]>((resolve, reject) => {
      const rows: T[] = []
      let cancelledBy: 'timeout' | 'aborted' | null = null
      let settled = false
      let stuck: ReturnType<typeof setTimeout> | undefined
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(stuck)
        opts.signal?.removeEventListener('abort', onAbort)
        fn()
      }
      const cancel = (why: 'timeout' | 'aborted') => {
        if (settled || cancelledBy) return
        cancelledBy = why
        try {
          conn.cancel()
        } catch {
          broken = true
        }
        // The attention normally ends the request within milliseconds; a connection
        // that never answers it is closed rather than handed to the next caller.
        stuck = setTimeout(() => {
          broken = true
          finish(() => reject(new StatementCancelled(why)))
        }, CANCEL_GRACE_MS)
      }
      const onAbort = () => cancel('aborted')
      const timer = setTimeout(() => cancel('timeout'), timeoutMs)
      const req = new driver.Request(native.sql, (err: Error | null) => {
        if (cancelledBy) {
          note(rows.length, cancelledBy)
          return finish(() => reject(new StatementCancelled(cancelledBy ?? 'timeout')))
        }
        if (err) {
          note(rows.length, err.message)
          return finish(() => reject(err))
        }
        note(rows.length)
        finish(() => resolve(rows))
      }) as TediousRequest
      req.on('row', (cols) => {
        const row: Record<string, unknown> = {}
        for (const c of cols) row[c.metadata.colName] = c.value
        rows.push(row as T)
      })
      client._assignBindings(req, native.bindings)
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        conn.execSql(req)
      } catch (e) {
        broken = true
        finish(() => reject(e))
      }
    })
  } finally {
    if (broken) {
      conn.connected = false
      try {
        if (!conn.closed) conn.close()
      } catch {
        /* already gone */
      }
    }
    await client.releaseConnection(conn)
  }
}

async function raceOther<T>(
  knex: Knex,
  sql: string,
  bindings: readonly unknown[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StatementCancelled('timeout')), timeoutMs)
    onAbort = () => reject(new StatementCancelled('aborted'))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const res = await Promise.race([knex.raw(sql, bindings as never), stop])
    return (Array.isArray(res) ? res : ((res as { rows?: T[] })?.rows ?? [])) as T[]
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}
