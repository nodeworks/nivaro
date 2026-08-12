import type { Knex } from 'knex'

// Per-alert entity-filter overrides (JSON [{field, values, labels}]) — an
// alert evaluates against its own filter scope (e.g. Zone 1 + FY 2026)
// independent of what any viewer has selected. EFP AlertDrawer parity.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_report_alerts', (t) => {
    t.text('filters').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_report_alerts', (t) => {
    t.dropColumn('filters')
  })
}
