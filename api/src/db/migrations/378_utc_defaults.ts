import type { Knex } from 'knex'
import { isMssql } from '../dialect.js'

/**
 * #749 — every nivaro_* column that defaulted to local GETDATE() /
 * CURRENT_TIMESTAMP now defaults to GETUTCDATE().
 *
 * The API writes timestamps as JS UTC; a row that relied on the default got
 * the SERVER's wall clock instead (Eastern on EFP), so the same column held
 * two clocks and anything comparing it with "now" was hours off. Only the
 * DEFAULT changes (a metadata operation, instant): historic values are left
 * as they are — shifting them needs a per-table decision about which rows
 * came from the default.
 *
 * Business tables are not touched. The readiness check `utc-defaults` lists
 * any local default that appears later; new migrations use utcNow() from
 * db/dialect.ts (pnpm lint:traps flags knex.fn.now() in a new migration).
 */
const LOCAL = `(dc.definition LIKE '%getdate()%' OR dc.definition LIKE '%current_timestamp%' OR dc.definition LIKE '%sysdatetime()%')`

/** One table at a time, each ALTER committed on its own: in a single batch
 *  transaction the schema locks on ~150 tables would be held until the end. */
export const config = { transaction: false }

async function localDefaults(knex: Knex) {
  return (await knex.raw(`
    SELECT t.name AS tbl, c.name AS col, dc.name AS cname
    FROM sys.default_constraints dc
    JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
    JOIN sys.tables t ON t.object_id = dc.parent_object_id
    WHERE t.name LIKE 'nivaro[_]%' AND ${LOCAL}`)) as Array<{
    tbl: string
    col: string
    cname: string
  }>
}

export async function up(knex: Knex): Promise<void> {
  if (!isMssql(knex)) return
  for (const r of await localDefaults(knex)) {
    await knex.raw(
      `ALTER TABLE ?? DROP CONSTRAINT ??; ALTER TABLE ?? ADD CONSTRAINT ?? DEFAULT (GETUTCDATE()) FOR ??`,
      [r.tbl, r.cname, r.tbl, r.cname, r.col]
    )
  }
}

export async function down(_knex: Knex): Promise<void> {
  // Deliberately one-way: restoring local-time defaults reintroduces the bug.
}
