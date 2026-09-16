import type { Knex } from 'knex'

/**
 * Lists batch B — #53 per-widget refresh interval on dashboards. Additive
 * and guarded; NULL = the page's default (60s).
 */
export async function up(knex: Knex): Promise<void> {
  if (
    (await knex.schema.hasTable('nivaro_dashboard_widgets')) &&
    !(await knex.schema.hasColumn('nivaro_dashboard_widgets', 'refresh_seconds'))
  ) {
    await knex.schema.alterTable('nivaro_dashboard_widgets', (t) => {
      t.integer('refresh_seconds').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_dashboard_widgets', 'refresh_seconds')) {
    await knex.schema.alterTable('nivaro_dashboard_widgets', (t) => {
      t.dropColumn('refresh_seconds')
    })
  }
}
