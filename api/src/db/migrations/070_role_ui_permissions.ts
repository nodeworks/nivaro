import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_roles', (t) => {
    t.text('ui_permissions').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_roles', (t) => {
    t.dropColumn('ui_permissions')
  })
}
