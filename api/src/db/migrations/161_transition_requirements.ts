import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_workflow_transitions', (t) => {
    t.text('requirements').nullable() // JSON RequirementEntry[] | null
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_workflow_transitions', (t) => {
    t.dropColumn('requirements')
  })
}
