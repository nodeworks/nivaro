import type { Knex } from 'knex'

/**
 * How a transition is described to PEOPLE (2026-09-24):
 *  - nivaro_workflow_transitions.notify_text — nvarchar(500), nullable. A plain
 *    sentence for emails and notifications ("Fusion accepted the transfer
 *    order, so the request is complete."). The transition's `label` stays
 *    the editor's / history's name for the route — an automatic route's
 *    label reads like a rule ("Auto-complete (Fusion accepted)"), which is
 *    what an admin wants in the pipeline editor and exactly what a
 *    requester does not want quoted at them. Edited on the transition form;
 *    NULL falls back to the label.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_workflow_transitions', 'notify_text'))) {
    await knex.schema.alterTable('nivaro_workflow_transitions', (t) => {
      t.string('notify_text', 500).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_workflow_transitions', 'notify_text')) {
    await knex.schema.alterTable('nivaro_workflow_transitions', (t) => {
      t.dropColumn('notify_text')
    })
  }
}
