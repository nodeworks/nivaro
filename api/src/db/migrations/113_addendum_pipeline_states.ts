import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collections', (t) => {
    t.text('addendum_allowed_states').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collections', (t) => {
    t.dropColumn('addendum_allowed_states')
  })
}
