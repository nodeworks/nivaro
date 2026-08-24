import type { Knex } from 'knex'

// Per-instance settings overrides: several instances (local dev, staging) can
// share one database and therefore one nivaro_settings row — but need e.g.
// different SMTP config. One row per instance key (NIVARO_INSTANCE env,
// defaulting to NODE_ENV), holding a JSON map of settings-column overrides
// that win over the shared row on this instance only. Edited in Settings →
// Instance.
export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasTable('nivaro_settings_overrides')
  if (!has) {
    await knex.schema.createTable('nivaro_settings_overrides', (t) => {
      t.increments('id')
      t.string('instance_key', 100).notNullable().unique()
      t.text('data').notNullable() // JSON: { settings_column: value }
      t.datetime('updated_at').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasTable('nivaro_settings_overrides')
  if (has) await knex.schema.dropTable('nivaro_settings_overrides')
}
