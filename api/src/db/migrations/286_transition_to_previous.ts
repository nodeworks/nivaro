import type { Knex } from 'knex'

/**
 * Return-to-previous transitions (uncancel, generalized): a transition
 * flagged `to_previous` targets whatever state the record occupied BEFORE it
 * entered the current one — mined from workflow history at execute time. The
 * row's own to_state stays as the fallback for records with no usable
 * history (e.g. started directly in the current state).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_workflow_transitions', 'to_previous'))) {
    await knex.schema.alterTable('nivaro_workflow_transitions', (t) => {
      t.boolean('to_previous').notNullable().defaultTo(false)
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_workflow_transitions', 'to_previous')) {
    await knex.schema.alterTable('nivaro_workflow_transitions', (t) => {
      t.dropColumn('to_previous')
    })
  }
}
