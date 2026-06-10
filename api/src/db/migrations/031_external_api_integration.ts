import type { Knex } from 'knex'

export async function up(knex: Knex) {
  await knex.schema.alterTable('nivaro_external_apis', (t) => {
    t.string('integration_type', 100).nullable()
    t.specificType('integration_config', 'nvarchar(max)').nullable()
  })
}

export async function down(knex: Knex) {
  await knex.schema.alterTable('nivaro_external_apis', (t) => {
    t.dropColumn('integration_config')
    t.dropColumn('integration_type')
  })
}
