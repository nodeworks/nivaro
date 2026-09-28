import type { Knex } from 'knex'

/**
 * Headline snapshots (#851): one row a day of the dashboard's budget headline
 * figures per (year, zone), written by the `dashboard-headline-snapshot` cron,
 * so the dashboard can show how far each figure moved and draw a sparkline.
 * `zone` NULL = every zone. `nivaro_settings.dashboard_headline` (JSON text)
 * says which custom query and which result columns feed it; NULL = off.
 *
 * The unique key is a CONSTRAINT, not knex's default unique index: on mssql
 * that index is filtered `WHERE zone IS NOT NULL`, which would let the
 * all-zones row (zone NULL) be written twice on one day.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_dashboard_snapshots'))) {
    await knex.schema.createTable('nivaro_dashboard_snapshots', (t) => {
      t.bigIncrements('id').primary()
      t.date('snapshot_date').notNullable()
      t.integer('year').notNullable()
      t.string('zone', 80).nullable()
      t.decimal('pubd', 18, 2).notNullable().defaultTo(0)
      t.decimal('spend', 18, 2).notNullable().defaultTo(0)
      t.decimal('committed', 18, 2).notNullable().defaultTo(0)
      t.decimal('remaining', 18, 2).notNullable().defaultTo(0)
      t.integer('projects').notNullable().defaultTo(0)
      t.datetime('created_at').nullable()
      t.unique(['snapshot_date', 'year', 'zone'], {
        indexName: 'ux_dashboard_snapshots_day',
        useConstraint: true
      })
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_settings', 'dashboard_headline'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('dashboard_headline').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'dashboard_headline')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('dashboard_headline')
    })
  }
  await knex.schema.dropTableIfExists('nivaro_dashboard_snapshots')
}
