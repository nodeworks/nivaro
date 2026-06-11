import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_workflow_states', (t) => {
    t.string('stage_visibility', 32).notNullable().defaultTo('always')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_workflow_states', (t) => {
    t.dropColumn('stage_visibility')
  })
}
