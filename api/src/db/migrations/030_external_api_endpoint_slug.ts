import type { Knex } from 'knex'

export async function up(knex: Knex) {
  await knex.schema.alterTable('nivaro_external_api_endpoints', (t) => {
    t.string('slug', 100).nullable()
  })
  // Backfill existing rows with their numeric id as slug
  await knex.raw(
    'UPDATE nivaro_external_api_endpoints SET slug = CAST(id AS NVARCHAR(100)) WHERE slug IS NULL'
  )
  await knex.schema.alterTable('nivaro_external_api_endpoints', (t) => {
    t.string('slug', 100).notNullable().alter()
  })
}

export async function down(knex: Knex) {
  await knex.schema.alterTable('nivaro_external_api_endpoints', (t) => {
    t.dropColumn('slug')
  })
}
