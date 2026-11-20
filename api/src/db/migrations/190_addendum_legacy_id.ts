import type { Knex } from 'knex'
import { isMssql } from '../dialect.js'
import { ensureIndex } from '../portable-ddl.js'

/**
 * Provenance marker for addendums imported from a legacy system (same pattern
 * as nivaro_activity/nivaro_revisions.legacy_id) — lets the import upsert
 * idempotently and re-run incrementally.
 */
export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_addendums', 'legacy_id')
  if (!has) {
    await knex.schema.alterTable('nivaro_addendums', (t) => {
      t.integer('legacy_id').nullable()
    })
    if (isMssql(knex))
      await knex.raw(
        `CREATE UNIQUE INDEX ux_nivaro_addendums_legacy_id ON nivaro_addendums (legacy_id) WHERE legacy_id IS NOT NULL`
      )
    else
      await ensureIndex(knex, {
        name: 'ux_nivaro_addendums_legacy_id',
        table: 'nivaro_addendums',
        columns: ['legacy_id'],
        unique: true,
        where: 'legacy_id IS NOT NULL'
      })
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_addendums', 'legacy_id')
  if (has) {
    await knex.raw(`DROP INDEX ux_nivaro_addendums_legacy_id ON nivaro_addendums`)
    await knex.schema.alterTable('nivaro_addendums', (t) => {
      t.dropColumn('legacy_id')
    })
  }
}
