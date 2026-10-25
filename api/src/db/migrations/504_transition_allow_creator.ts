import type { Knex } from 'knex'

/**
 * Owner-or-creator transitions (army 2026-10-24): nivaro_workflow_transitions.
 * allow_creator — bit, default 0. With require_owner on, the record's creator
 * may run the move too, even without owning the current step (requester moves
 * such as Cancel / Uncancel). The gate is checkTransitionOwner
 * (services/record-access.ts); every reader probes the column, so a tenant
 * behind this migration keeps working. Same shape as migration 397.
 */
const TABLE = 'nivaro_workflow_transitions'

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (await knex.schema.hasColumn(TABLE, 'allow_creator')) return
  await knex.schema.alterTable(TABLE, (t) => {
    t.boolean('allow_creator').notNullable().defaultTo(false)
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (!(await knex.schema.hasColumn(TABLE, 'allow_creator'))) return
  await knex.schema.alterTable(TABLE, (t) => {
    t.dropColumn('allow_creator')
  })
}
