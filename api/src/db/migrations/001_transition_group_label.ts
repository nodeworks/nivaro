import type { Knex } from 'knex'

export async function up(knex: Knex) {
  await knex.schema.alterTable('nivaro_workflow_transitions', (t) => {
    t.string('group_label', 255).nullable().defaultTo(null)
  })
}

export async function down(knex: Knex) {
  await knex.schema.alterTable('nivaro_workflow_transitions', (t) => {
    t.dropColumn('group_label')
  })
}
