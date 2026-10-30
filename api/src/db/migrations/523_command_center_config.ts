import type { Knex } from 'knex'

/**
 * Migration 523 — Command Center configuration.
 *
 *   nivaro_settings.command_center  text NULL
 *     JSON — which geo collections the map offers, where regions come from (a collection, the
 *     junction that places geo records in a region, the user-scope dimension that places people),
 *     the "stuck" threshold and every role's starter layout. services/command-center/config.ts
 *     normalizeCcConfig is the one reader/writer shape; NULL = auto-detect everything from the
 *     data model (no tenant-specific table names in core).
 *
 * Config, like overview_role_defaults (migration 522). Guarded + additive.
 */
const COLUMN = 'command_center'

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_settings'))) return
  if (await knex.schema.hasColumn('nivaro_settings', COLUMN)) return
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.text(COLUMN).nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_settings'))) return
  if (!(await knex.schema.hasColumn('nivaro_settings', COLUMN))) return
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.dropColumn(COLUMN)
  })
}
