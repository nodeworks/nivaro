import type { Knex } from 'knex'

// Every per-record history read filters nivaro_revisions / nivaro_activity by
// (collection, item): the collision baseline (MAX id), field-touch, the
// revisions panel, comments/related, last-touch, cell provenance. Neither
// table had an index on that pair — with ten million rows each, every record
// open scanned the whole table several times (8s for one MAX on staging).
//
// The build takes MINUTES on a table that size, far past tedious' 15s request
// timeout that knex.raw rides — so each CREATE INDEX runs on its own
// long-timeout request (the staged-import runLongSql pattern). Offline
// builds (Standard Edition has no ONLINE = ON): expect history writes to
// block while each index builds. A fresh database builds them instantly.
const ONE_HOUR = 60 * 60 * 1000

async function runLong(knex: Knex, sql: string): Promise<void> {
  const client = (knex as any).client
  if (client.config?.client !== 'mssql') {
    await knex.raw(sql)
    return
  }
  const Driver = client._driver() as {
    Request: new (sql: string, cb: (err: Error | null) => void) => unknown
  }
  const conn = (await client.acquireConnection()) as { execSqlBatch(r: unknown): void }
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const done = (fn: () => void) => {
        if (!settled) {
          settled = true
          fn()
        }
      }
      const req = new Driver.Request(sql, (err: Error | null) => {
        if (err) done(() => reject(err))
      }) as {
        on(ev: 'error', h: (e: Error) => void): unknown
        once(ev: 'requestCompleted', h: () => void): unknown
        setTimeout?: (ms: number) => void
      }
      req.setTimeout?.(ONE_HOUR)
      req.once('requestCompleted', () => done(() => resolve()))
      req.on('error', (e) => done(() => reject(e)))
      conn.execSqlBatch(req)
    })
  } finally {
    await client.releaseConnection(conn)
  }
}

export async function up(knex: Knex): Promise<void> {
  await runLong(
    knex,
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nivaro_revisions_collection_item')
       CREATE INDEX ix_nivaro_revisions_collection_item
         ON nivaro_revisions (collection, item, id DESC)`
  )
  await runLong(
    knex,
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nivaro_activity_collection_item')
       CREATE INDEX ix_nivaro_activity_collection_item
         ON nivaro_activity (collection, item, timestamp DESC)`
  )
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nivaro_revisions_collection_item')
    DROP INDEX ix_nivaro_revisions_collection_item ON nivaro_revisions
  `)
  await knex.raw(`
    IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nivaro_activity_collection_item')
    DROP INDEX ix_nivaro_activity_collection_item ON nivaro_activity
  `)
}
