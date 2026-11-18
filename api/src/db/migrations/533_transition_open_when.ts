import type { Knex } from 'knex'

/**
 * "Anyone can make this move when…" (Rob 2026-11-18):
 * nivaro_workflow_transitions.open_when — nullable nvarchar(max), JSON in the
 * condition_rules format (a rule list, or a map keyed by collection). With
 * require_owner on, anyone who passes the move's other gates may run it while
 * the rules hold for the record (services/transition-open-when.ts); unset,
 * unusable or false → the owner rule applies as before. Every reader probes
 * the column, so a tenant behind this migration keeps working. Additive,
 * guarded both ways.
 */
const TABLE = 'nivaro_workflow_transitions'
const COLUMN = 'open_when'

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (await knex.schema.hasColumn(TABLE, COLUMN)) return
  await knex.schema.alterTable(TABLE, (t) => {
    t.text(COLUMN).nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) return
  await knex.schema.alterTable(TABLE, (t) => {
    t.dropColumn(COLUMN)
  })
}
