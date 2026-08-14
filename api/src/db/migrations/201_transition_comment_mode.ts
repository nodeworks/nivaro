import type { Knex } from 'knex'

/**
 * Whether taking a transition should stop and ask for a note.
 *
 *   'none'     — click acts. The default, because most transitions are simply
 *                "yes, move it on", and a confirm step on those is a second
 *                click that carries no information.
 *   'optional' — confirm step, note may be left blank (the previous behaviour
 *                for every transition).
 *   'required' — confirm step, and the note must be filled in.
 *
 * Per transition rather than per template: within one workflow an Approve
 * usually needs no explanation while a Send Back always does.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_workflow_transitions', 'comment_mode')) return
  await knex.schema.alterTable('nivaro_workflow_transitions', (t) => {
    t.string('comment_mode', 20).notNullable().defaultTo('none')
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_workflow_transitions', 'comment_mode'))) return
  await knex.schema.alterTable('nivaro_workflow_transitions', (t) => {
    t.dropColumn('comment_mode')
  })
}
