import type { Knex } from 'knex'

/**
 * Data-protection trio: legal holds (retention/purge exemptions with an audit
 * trail), per-collection read-access logging, per-collection export
 * watermarking.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_legal_holds'))) {
    await knex.schema.createTable('nivaro_legal_holds', (t) => {
      t.increments('id')
      /** Record hold: collection + item_id. User hold: user. One or the other. */
      t.string('collection', 255).nullable()
      t.string('item_id', 255).nullable()
      t.uuid('user').nullable()
      t.string('reason', 1000).notNullable()
      t.uuid('placed_by').nullable()
      t.dateTime('created_at').notNullable()
      t.dateTime('released_at').nullable()
      t.uuid('released_by').nullable()
      t.index(['collection', 'item_id'])
      t.index(['user'])
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_collections', 'read_logging'))) {
    await knex.schema.alterTable('nivaro_collections', (t) => {
      /** Log single-record reads (who opened what, throttled hourly). */
      t.boolean('read_logging').notNullable().defaultTo(false)
      /** Stamp exports with the exporter's name + timestamp. */
      t.boolean('export_watermark').notNullable().defaultTo(false)
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_legal_holds')
  if (await knex.schema.hasColumn('nivaro_collections', 'read_logging')) {
    await knex.schema.alterTable('nivaro_collections', (t) => {
      t.dropColumn('read_logging')
      t.dropColumn('export_watermark')
    })
  }
}
