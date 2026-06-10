import type { Knex } from 'knex'

export async function up(knex: Knex) {
  await knex.schema.alterTable('nivaro_submission_forms', (t) => {
    t.specificType('form_config', 'nvarchar(max)').nullable()
  })
}

export async function down(knex: Knex) {
  await knex.schema.alterTable('nivaro_submission_forms', (t) => {
    t.dropColumn('form_config')
  })
}
