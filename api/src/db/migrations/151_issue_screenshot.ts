import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_issues', (t) => {
    t.text('screenshot', 'longtext').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_issues', (t) => {
    t.dropColumn('screenshot')
  })
}
