import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.renameTable('nivaro_change_orders', 'nivaro_addendum_approvals')
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.renameTable('nivaro_addendum_approvals', 'nivaro_change_orders')
}
