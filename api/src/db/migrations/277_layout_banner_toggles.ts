import type { Knex } from 'knex'

/**
 * Per-layout banner visibility: a layout can opt out of the record integrity
 * banner and/or the SLA breach banner (both default ON, matching historic
 * behaviour). The collection-wide integrity_badge toggle still wins when off.
 */
export async function up(knex: Knex): Promise<void> {
  for (const col of ['hide_integrity_banner', 'hide_sla_banner']) {
    if (!(await knex.schema.hasColumn('nivaro_collection_layouts', col))) {
      await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
        t.boolean(col).notNullable().defaultTo(false)
      })
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const col of ['hide_integrity_banner', 'hide_sla_banner']) {
    if (await knex.schema.hasColumn('nivaro_collection_layouts', col)) {
      await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
        t.dropColumn(col)
      })
    }
  }
}
