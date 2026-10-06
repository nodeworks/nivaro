import type { Knex } from 'knex'

/**
 * Acting-for stamp (#645).
 *   - nivaro_workflow_history.on_behalf_of (uuid NULL, NO FK): when a person
 *     moves a record as the DELEGATE of an out-of-office owner of the step —
 *     and is not an owner of that step themselves — the owner they acted for.
 *     `user` stays the person who clicked; this names whose signature it
 *     stood in for. No FK on purpose: a deleted or merged user must never
 *     block a history row (same rule as nivaro_erp_submissions.requested_by).
 *     NULL on every row written before this migration, on auto transitions,
 *     and whenever the actor owned the step in their own right.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_workflow_history'))) return
  if (!(await knex.schema.hasColumn('nivaro_workflow_history', 'on_behalf_of'))) {
    await knex.schema.alterTable('nivaro_workflow_history', (t) => {
      t.uuid('on_behalf_of').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_workflow_history'))) return
  if (await knex.schema.hasColumn('nivaro_workflow_history', 'on_behalf_of')) {
    await knex.schema.alterTable('nivaro_workflow_history', (t) => {
      t.dropColumn('on_behalf_of')
    })
  }
}
