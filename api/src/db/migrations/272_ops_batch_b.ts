import type { Knex } from 'knex'

// Ops batch B: cron pause persistence (#198), log alert rules (#253),
// per-collection activity/trash retention overrides (#257/#258).
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'paused_crons'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('paused_crons').nullable() // JSON string[] of cron ids
    })
  }
  if (!(await knex.schema.hasTable('nivaro_log_alert_rules'))) {
    await knex.schema.createTable('nivaro_log_alert_rules', (t) => {
      t.increments('id')
      t.string('name', 200).notNullable()
      t.string('pattern', 500).notNullable() // regex over log lines
      t.string('level', 20).nullable() // minimum level to consider (null = any)
      t.boolean('is_active').notNullable().defaultTo(true)
      t.uuid('created_by').nullable()
      t.datetime('last_matched_at').nullable()
      t.datetime('created_at').notNullable()
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_collections', 'activity_retention_days'))) {
    await knex.schema.alterTable('nivaro_collections', (t) => {
      t.integer('activity_retention_days').nullable()
      t.integer('trash_retention_days').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'paused_crons')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('paused_crons')
    })
  }
  if (await knex.schema.hasTable('nivaro_log_alert_rules')) {
    await knex.schema.dropTable('nivaro_log_alert_rules')
  }
  if (await knex.schema.hasColumn('nivaro_collections', 'activity_retention_days')) {
    await knex.schema.alterTable('nivaro_collections', (t) => {
      t.dropColumn('activity_retention_days')
      t.dropColumn('trash_retention_days')
    })
  }
}
