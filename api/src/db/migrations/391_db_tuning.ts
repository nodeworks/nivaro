import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Database tuning (#996): the proposal ledger and the recorded parameter sets a
 * procedure proof replays. Both are per-database facts — RUNTIME in config-inventory,
 * never promoted. `applied_by` / `dismissed_by` are bare uuids (no FK): a deleted admin
 * must never block a read or a rollback.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_tuning_proposals'))) {
    await knex.schema.createTable('nivaro_tuning_proposals', (t) => {
      t.string('id', 36).primary()
      t.string('kind', 20).notNullable()
      t.string('target', 300).notNullable()
      t.string('fingerprint', 64).notNullable()
      t.string('status', 20).notNullable().defaultTo('proposed')
      t.string('title', 300).notNullable()
      t.text('evidence').nullable()
      t.text('proof').nullable()
      t.bigInteger('estimate_ms_per_day').notNullable().defaultTo(0)
      t.string('risk', 12).notNullable().defaultTo('reversible')
      t.boolean('replicated').notNullable().defaultTo(false)
      t.string('dialect_note', 200).nullable()
      t.text('apply').notNullable()
      t.text('undo').notNullable()
      t.datetime('applied_at').nullable()
      t.uuid('applied_by').nullable()
      t.datetime('watch_until').nullable()
      t.text('watch_baseline').nullable()
      t.datetime('rolled_back_at').nullable()
      t.string('rollback_reason', 500).nullable()
      t.datetime('dismissed_at').nullable()
      t.uuid('dismissed_by').nullable()
      t.string('dismiss_note', 500).nullable()
      t.datetime('first_seen').notNullable().defaultTo(utcNow(knex))
      t.datetime('last_seen').notNullable().defaultTo(utcNow(knex))
      t.integer('run_id').nullable()
      t.index(['status', 'estimate_ms_per_day'], 'ix_tuning_proposals_status_estimate')
      t.index(['fingerprint'], 'ix_tuning_proposals_fingerprint')
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_settings', 'db_tuning'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('db_tuning').nullable()
    })
  }
  if (!(await knex.schema.hasTable('nivaro_tuning_param_sets'))) {
    await knex.schema.createTable('nivaro_tuning_param_sets', (t) => {
      t.increments('id')
      t.string('target_kind', 10).notNullable() // query | proc
      t.string('target', 300).notNullable()
      t.text('params').notNullable()
      t.string('hash', 40).notNullable()
      t.integer('seen_count').notNullable().defaultTo(1)
      t.datetime('last_seen').notNullable().defaultTo(utcNow(knex))
      t.unique(['target_kind', 'target', 'hash'], { indexName: 'ux_tuning_param_sets' })
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_tuning_param_sets'))
    await knex.schema.dropTable('nivaro_tuning_param_sets')
  if (await knex.schema.hasTable('nivaro_tuning_proposals'))
    await knex.schema.dropTable('nivaro_tuning_proposals')
}
