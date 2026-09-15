import type { Knex } from 'knex'

/**
 * List-row Actions menu gate (2026-09-15):
 *  - nivaro_workflow_transitions.in_row_menu — bit, default 1. Whether a
 *    manual transition is offered from the per-row "Actions" menu in the
 *    collection browser and queue tables. The record form's pipeline panel
 *    ignores it — this only curates what a list surface offers in one click
 *    (send-backs and cancels yes, approvals no, typically). Edited per route
 *    in the pipeline editor's transition form.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_workflow_transitions', 'in_row_menu'))) {
    await knex.schema.alterTable('nivaro_workflow_transitions', (t) => {
      t.boolean('in_row_menu').notNullable().defaultTo(true)
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_workflow_transitions', 'in_row_menu')) {
    await knex.schema.alterTable('nivaro_workflow_transitions', (t) => {
      t.dropColumn('in_row_menu')
    })
  }
}
