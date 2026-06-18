import type { Knex } from 'knex'

export async function up(knex: Knex) {
  await knex.schema.alterTable('nivaro_field_groups', (t) => {
    t.integer('container_id').nullable().references('id').inTable('nivaro_field_groups').onDelete('NO ACTION').onUpdate('NO ACTION')
    t.string('tab_mode', 10).nullable()
  })
}

export async function down(knex: Knex) {
  await knex.schema.alterTable('nivaro_field_groups', (t) => {
    t.dropColumn('tab_mode')
    t.dropColumn('container_id')
  })
}
