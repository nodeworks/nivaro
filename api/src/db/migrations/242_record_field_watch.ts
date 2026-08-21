import type { Knex } from 'knex'

/**
 * Field-level RECORD watch (#58): a field watch may now name one record
 * (item_id) instead of covering the whole collection — "tell me when THIS
 * PO's amount changes". Off by default behind nivaro_settings.
 * field_watch_enabled; the self-serve watch button only appears when an
 * admin turns the feature on.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_field_watches', 'item_id'))) {
    await knex.schema.alterTable('nivaro_field_watches', (t) => {
      t.string('item_id', 255).nullable()
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_settings', 'field_watch_enabled'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.boolean('field_watch_enabled').notNullable().defaultTo(false)
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_field_watches', (t) => {
    t.dropColumn('item_id')
  })
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.dropColumn('field_watch_enabled')
  })
}
