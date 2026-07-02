import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_addendum_approvals', (t) => {
    t.text('previous_data').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_addendum_approvals', (t) => {
    t.dropColumn('previous_data')
  })
}
