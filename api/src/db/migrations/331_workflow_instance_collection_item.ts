import type { Knex } from 'knex'

// nivaro_workflow_instances is looked up by (collection, item) constantly —
// every "is this record canceled / what state is it in" check correlates
// `cxi.collection = @c AND cxi.item = CAST(<row>.id AS NVARCHAR(50))` — but the
// table carried ONLY its primary key on id. With ~115k instances that meant a
// full scan per candidate row, so a project drill-down that touches a few
// hundred workflows and inventory requests spent its whole time here: the
// project-360 hub read took 16.4s and its metrics 10.7s, against 1.5s and
// 0.26s with this index.
//
// It is easy to miss because the same statement is FAST when run with literal
// values — the bad plan only appears for the parameterized form the app
// actually sends, which is what a cached plan is built from.
//
// The pair is deliberately keyed in this order: `collection` is the low-
// cardinality prefix every lookup supplies, `item` the selective part.
// current_state is INCLUDEd because the canceled check joins straight to it,
// which keeps the lookup covering.
//
// Same build caveat as migration 321: CREATE INDEX on a table this size can
// outrun tedious' 15s request timeout that knex.raw rides, so it runs on its
// own long-timeout request. This table is small enough to build in well under
// a second today, but the pattern costs nothing and survives growth.
const ONE_HOUR = 60 * 60 * 1000

async function runLong(knex: Knex, sql: string): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: internal Knex/tedious plumbing
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
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nivaro_workflow_instances_collection_item')
       CREATE INDEX ix_nivaro_workflow_instances_collection_item
         ON nivaro_workflow_instances (collection, item) INCLUDE (current_state)`
  )
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nivaro_workflow_instances_collection_item')
    DROP INDEX ix_nivaro_workflow_instances_collection_item ON nivaro_workflow_instances
  `)
}
