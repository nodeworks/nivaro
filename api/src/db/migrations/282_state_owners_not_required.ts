import type { Knex } from 'knex'

/** Rob 2026-08-26: some states legitimately need no owners (Started,
 *  Completed) — a per-state flag so owner-gap and coverage reports stop
 *  flagging them as problems. */
export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_workflow_states', 'owners_not_required')
  if (!has) {
    await knex.schema.alterTable('nivaro_workflow_states', (t) => {
      t.boolean('owners_not_required').notNullable().defaultTo(false)
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_workflow_states', 'owners_not_required')
  if (has) {
    await knex.schema.alterTable('nivaro_workflow_states', (t) => {
      t.dropColumn('owners_not_required')
    })
  }
}
