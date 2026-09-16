import type { Knex } from 'knex'

/**
 * #41 + #54 — query cache warmers and cron chains: a custom query flagged `warm_daily` is pre-run
 * by the 06:00 `query-cache-warmers` cron with its default parameters, so
 * the first person opening a heavy report page hits a warm Redis result.
 */
export async function up(knex: Knex): Promise<void> {
  if (
    (await knex.schema.hasTable('nivaro_custom_queries')) &&
    !(await knex.schema.hasColumn('nivaro_custom_queries', 'warm_daily'))
  ) {
    await knex.schema.alterTable('nivaro_custom_queries', (t) => {
      t.boolean('warm_daily').notNullable().defaultTo(false)
    })
  }
  // #54 — cron chains: {childJobId: parentJobId}, hydrated at boot like
  // cron_overrides (routes/cron.ts writes it, server.ts reads it).
  if (
    (await knex.schema.hasTable('nivaro_settings')) &&
    !(await knex.schema.hasColumn('nivaro_settings', 'cron_chains'))
  ) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('cron_chains').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_custom_queries', 'warm_daily')) {
    await knex.schema.alterTable('nivaro_custom_queries', (t) => {
      t.dropColumn('warm_daily')
    })
  }
  if (await knex.schema.hasColumn('nivaro_settings', 'cron_chains')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('cron_chains')
    })
  }
}
