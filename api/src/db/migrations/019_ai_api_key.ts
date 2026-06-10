import type { Knex } from 'knex'

export async function up(knex: Knex) {
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.specificType('anthropic_api_key', 'nvarchar(500)').nullable()
  })
}

export async function down(knex: Knex) {
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.dropColumn('anthropic_api_key')
  })
}
