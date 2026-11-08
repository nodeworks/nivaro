import type { Knex } from 'knex'

/**
 * Retention: "left the company" gate (2026-11-08).
 *
 *   nivaro_retention_policies.require_directory_gone  bit NOT NULL DEFAULT 0
 *     On = the policy only touches people directory sync marks as gone
 *     (nivaro_users.directory_status 'missing' or 'disabled'), on top of no
 *     activity and no sign-in since the cutoff. A policy with it on refuses
 *     to run while directory sync is off or has not finished recently.
 *
 * Additive with a constant default (metadata-only on SQL Server); guarded so a
 * re-run is a no-op. The retention service probes for the column and treats
 * it as off when it is missing.
 */
const TABLE = 'nivaro_retention_policies'
const COLUMN = 'require_directory_gone'

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (await knex.schema.hasColumn(TABLE, COLUMN)) return
  await knex.schema.alterTable(TABLE, (t) => {
    t.boolean(COLUMN).notNullable().defaultTo(false)
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) return
  // SQL Server names the default constraint; knex drops it with the column.
  await knex.schema.alterTable(TABLE, (t) => {
    t.dropColumn(COLUMN)
  })
}
