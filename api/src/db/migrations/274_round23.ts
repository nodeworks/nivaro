import type { Knex } from 'knex'

// Round 23: role-scoped dashboards (#454) + auto-retry policies on external
// APIs (#469) + async export jobs need no table (job runs + nivaro_files).
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_dashboards', 'role_id'))) {
    await knex.schema.alterTable('nivaro_dashboards', (t) => {
      t.uuid('role_id').nullable() // no FK — mirrors nivaro_saved_views role scoping
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_external_apis', 'retry_policy'))) {
    await knex.schema.alterTable('nivaro_external_apis', (t) => {
      t.text('retry_policy').nullable() // JSON {max_attempts, backoff_minutes}
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_erp_submissions', 'retry_count'))) {
    await knex.schema.alterTable('nivaro_erp_submissions', (t) => {
      t.integer('retry_count').notNullable().defaultTo(0)
      t.datetime('next_retry_at').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_dashboards', 'role_id')) {
    await knex.schema.alterTable('nivaro_dashboards', (t) => {
      t.dropColumn('role_id')
    })
  }
  if (await knex.schema.hasColumn('nivaro_external_apis', 'retry_policy')) {
    await knex.schema.alterTable('nivaro_external_apis', (t) => {
      t.dropColumn('retry_policy')
    })
  }
  if (await knex.schema.hasColumn('nivaro_erp_submissions', 'retry_count')) {
    await knex.schema.alterTable('nivaro_erp_submissions', (t) => {
      t.dropColumn('retry_count')
      t.dropColumn('next_retry_at')
    })
  }
}
