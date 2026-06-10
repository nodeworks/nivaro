import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  // Locales available for field translations; managed in Settings → Localization
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.specificType('available_locales', 'nvarchar(max)').nullable() // JSON array, default ['en']
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.dropColumn('available_locales')
  })
}
