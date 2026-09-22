import type { Knex } from 'knex'

/**
 * nivaro_config_snapshots (#523) — the nightly config snapshot, stored.
 *
 * /config-diff compared an uploaded file against the live rows; nothing
 * answered "what drifted since Friday" without someone remembering to
 * export one. The `config-snapshot` cron stores one gzipped snapshot a day
 * (≈13 MB of JSON compresses to well under 1 MB), pruned to the newest 45,
 * and the compare route diffs today's live config against any stored one.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_config_snapshots'))) {
    await knex.schema.createTable('nivaro_config_snapshots', (t) => {
      t.increments('id').primary()
      t.dateTime('taken_at').notNullable()
      t.string('version', 40).nullable()
      t.string('environment', 40).nullable()
      t.integer('tables').notNullable().defaultTo(0)
      t.integer('rows').notNullable().defaultTo(0)
      t.string('content_hash', 64).notNullable()
      t.integer('bytes').notNullable().defaultTo(0)
      t.text('snapshot_gz').notNullable() // base64 of gzip(JSON)
      t.string('trigger', 20).notNullable().defaultTo('cron') // cron | manual
      t.uuid('created_by').nullable()
      t.index(['taken_at'], 'ix_config_snapshots_taken_at')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_config_snapshots'))
    await knex.schema.dropTable('nivaro_config_snapshots')
}
