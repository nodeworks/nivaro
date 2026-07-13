import type { Knex } from 'knex'

/**
 * Global SLA holiday list — JSON array of 'YYYY-MM-DD' strings on the
 * settings singleton, alongside the existing business-day schedule columns
 * (sla_business_day_start/end, sla_business_days). Holiday dates count zero
 * business hours regardless of weekday.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.text('sla_holidays')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.dropColumn('sla_holidays')
  })
}
