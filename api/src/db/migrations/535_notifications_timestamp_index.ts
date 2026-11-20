import type { Knex } from 'knex'
import { runLongSql } from '../../services/run-long.js'
import { isMssql } from '../dialect.js'
import { ensureIndex } from '../portable-ddl.js'

/**
 * nivaro_notifications ([timestamp]) INCLUDE (the columns delivery analytics
 * aggregates read).
 *
 * Every Delivery → Analytics figure is a windowed aggregate over the
 * notifications table, and the table had no index on [timestamp]: each
 * statement scanned the whole clustered index, however short the window. The
 * INCLUDE carries the narrow columns the counts group and filter on (read
 * state, people, category, lane, kind, record), so a window is a range seek on
 * the index leaf; the JSON columns (delivery, delivery_reason) stay off it —
 * nvarchar(max) would make the index as wide as the table.
 *
 * CREATE INDEX only — no column changes (production is a replication
 * publisher; an index is not a published article change). Built on its own
 * long request outside knex's batch transaction (migration 342's pattern), with
 * the columns the database actually has, on the migration connection, and
 * skipped when it already exists.
 */
export const config = { transaction: false }

const TABLE = 'nivaro_notifications'
const INDEX = 'ix_nivaro_notifications_timestamp'
const INCLUDE = [
  'status',
  'read_at',
  'recipient',
  'sender',
  'category',
  'lane',
  'kind',
  'collection',
  'item'
]

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (!(await knex.schema.hasColumn(TABLE, 'timestamp'))) return
  const include: string[] = []
  for (const c of INCLUDE) if (await knex.schema.hasColumn(TABLE, c)) include.push(c)
  if (!isMssql(knex)) {
    // Postgres keeps the INCLUDE columns; MySQL indexes [timestamp] alone (db/portable-ddl.ts).
    await ensureIndex(knex, { name: INDEX, table: TABLE, columns: ['timestamp'], include })
    return
  }
  const inc = include.length ? ` INCLUDE (${include.map((c) => `[${c}]`).join(', ')})` : ''
  await runLongSql(
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${INDEX}' AND object_id = OBJECT_ID('${TABLE}'))
       CREATE INDEX ${INDEX} ON ${TABLE} ([timestamp])${inc}`,
    { knex, timeoutMs: 60 * 60 * 1000 }
  )
}

export async function down(knex: Knex): Promise<void> {
  if (!isMssql(knex)) return
  await knex.raw(`
    IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${INDEX}' AND object_id = OBJECT_ID('${TABLE}'))
    DROP INDEX ${INDEX} ON ${TABLE}
  `)
}
