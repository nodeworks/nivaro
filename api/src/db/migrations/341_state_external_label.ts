import type { Knex } from 'knex'

/**
 * nivaro_workflow_states.external_label — the name an outside system knows
 * this state by. Integrations that receive a state name (push actions, exports
 * to a partner) render `external_label | default: label`, so a label rename
 * in the editor never changes what a partner is sent. NULL = same as label.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_workflow_states'))) return
  if (!(await knex.schema.hasColumn('nivaro_workflow_states', 'external_label'))) {
    await knex.schema.alterTable('nivaro_workflow_states', (t) => {
      t.string('external_label', 255).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_workflow_states', 'external_label')) {
    await knex.schema.alterTable('nivaro_workflow_states', (t) => {
      t.dropColumn('external_label')
    })
  }
}
