import type { Knex } from 'knex'

// `state_field_map` on nivaro_workflow_bindings: optional JSON {stateKey: value}
// written to the bound record's state_field instead of the raw state key —
// lets a binding mirror into legacy INT/enum state columns (e.g.
// inventory_request.request_state FK → inventory_request_states ids).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_workflow_bindings', (t) => {
    t.text('state_field_map').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_workflow_bindings', (t) => {
    t.dropColumn('state_field_map')
  })
}
