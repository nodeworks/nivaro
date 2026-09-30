import type { Knex } from 'knex'

/**
 * SLO dashboard (#666).
 *   - nivaro_api_logs.instance (varchar 60): which instance served the
 *     request (NIVARO_INSTANCE, else NODE_ENV). Several instances can share
 *     one database — the dev laptop and staging do — and an SLO is per
 *     environment. NULL on rows written before this migration.
 *   - nivaro_settings.slo_targets (text JSON): { availability_pct, p95_ms,
 *     window_days } — NULL = 99.5 %, 2000 ms, 7 days.
 */
export async function up(knex: Knex): Promise<void> {
  if (
    (await knex.schema.hasTable('nivaro_api_logs')) &&
    !(await knex.schema.hasColumn('nivaro_api_logs', 'instance'))
  ) {
    await knex.schema.alterTable('nivaro_api_logs', (t) => {
      t.string('instance', 60).nullable()
    })
  }
  if (
    (await knex.schema.hasTable('nivaro_settings')) &&
    !(await knex.schema.hasColumn('nivaro_settings', 'slo_targets'))
  ) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('slo_targets').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_api_logs', 'instance'))
    await knex.schema.alterTable('nivaro_api_logs', (t) => t.dropColumn('instance'))
  if (await knex.schema.hasColumn('nivaro_settings', 'slo_targets'))
    await knex.schema.alterTable('nivaro_settings', (t) => t.dropColumn('slo_targets'))
}
