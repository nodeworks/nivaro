import type { Knex } from 'knex'

// Per-pipeline start-state overrides for addendum workflow instances:
// JSON [{ pipeline_id, state_key }] on the parent collection. When an
// addendum is created with a workflow template that has a rule here, its
// instance starts in that state instead of the template's is_initial state.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collections', (t) => {
    t.text('addendum_start_states').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collections', (t) => {
    t.dropColumn('addendum_start_states')
  })
}
