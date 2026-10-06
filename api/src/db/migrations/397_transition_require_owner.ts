import type { Knex } from 'knex'

/**
 * Owner-only transitions (#794): nivaro_workflow_transitions.require_owner —
 * bit, default 0. The manual execute paths (REST + GraphQL) refuse with 403
 * TRANSITION_OWNER_REQUIRED unless the caller owns the record's current step
 * (delegation applied; admins pass), and the instance read leaves it out of
 * available_transitions. Edited per route in the pipeline editor.
 */
const TABLE = 'nivaro_workflow_transitions'

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (await knex.schema.hasColumn(TABLE, 'require_owner')) return
  await knex.schema.alterTable(TABLE, (t) => {
    t.boolean('require_owner').notNullable().defaultTo(false)
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (!(await knex.schema.hasColumn(TABLE, 'require_owner'))) return
  await knex.schema.alterTable(TABLE, (t) => {
    t.dropColumn('require_owner')
  })
}
