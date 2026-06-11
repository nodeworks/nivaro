import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_workflow_bindings', (t) => {
    t.boolean('auto_start').notNullable().defaultTo(false)
    t.string('auto_start_state', 36).nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_workflow_bindings', (t) => {
    t.dropColumn('auto_start')
    t.dropColumn('auto_start_state')
  })
}
