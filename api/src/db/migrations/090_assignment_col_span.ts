import type { Knex } from 'knex'

export async function up(knex: Knex) {
  const has = await knex.schema.hasColumn('nivaro_layout_field_assignments', 'col_span')
  if (!has) {
    await knex.schema.alterTable('nivaro_layout_field_assignments', (t) => {
      t.integer('col_span').nullable()
    })
  }
}

export async function down(knex: Knex) {
  await knex.schema.alterTable('nivaro_layout_field_assignments', (t) => {
    t.dropColumn('col_span')
  })
}
