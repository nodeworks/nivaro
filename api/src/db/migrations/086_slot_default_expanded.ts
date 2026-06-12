import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_layout_field_assignments', 'default_expanded')
  if (!has) {
    await knex.schema.alterTable('nivaro_layout_field_assignments', (t) => {
      t.specificType('default_expanded', 'bit').notNullable().defaultTo(1)
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_layout_field_assignments', (t) => {
    t.dropColumn('default_expanded')
  })
}
