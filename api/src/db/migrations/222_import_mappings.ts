import type { Knex } from 'knex'

/**
 * Import mapping memory — the CSV wizard's column mapping, keyed by
 * (collection, header signature) so re-importing the same-shaped file
 * auto-applies last time's mapping instead of starting from scratch.
 * One row per shape, instance-wide, last write wins: the operator who
 * corrected a mapping fixed it for everyone.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_import_mappings'))) {
    await knex.schema.createTable('nivaro_import_mappings', (t) => {
      t.increments('id')
      t.string('collection', 255).notNullable()
      /** sha256 of the sorted, lowercased header list. */
      t.string('header_hash', 64).notNullable()
      /** The original headers, for the "applied saved mapping" explanation. */
      t.text('headers').notNullable()
      t.text('column_map').notNullable()
      t.string('id_field', 255).nullable()
      t.string('duplicate_strategy', 50).nullable()
      t.uuid('updated_by').nullable()
      t.dateTime('updated_at').notNullable()
      t.unique(['collection', 'header_hash'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_import_mappings')
}
