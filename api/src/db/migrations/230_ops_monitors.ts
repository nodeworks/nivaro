import type { Knex } from 'knex'

/**
 * Ops monitors — one framework for the always-watching checks: data freshness
 * (an integration-fed collection went quiet), deploy regression (p95/error
 * rate degraded after a version change), and synthetic probes (a scripted
 * request slowed or broke). One config table, one evaluator cron, results in
 * nivaro_job_runs (kind 'monitor'), failures as deduped nivaro_issues.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_monitors'))) {
    await knex.schema.createTable('nivaro_monitors', (t) => {
      t.increments('id')
      /** 'freshness' | 'deploy_regression' | 'synthetic' */
      t.string('type', 30).notNullable()
      t.string('name', 200).notNullable()
      /** Type-specific JSON config. */
      t.text('config').nullable()
      /** Evaluator memory (last version seen, baselines, streaks) — JSON. */
      t.text('state').nullable()
      t.boolean('is_active').notNullable().defaultTo(true)
      /** 'ok' | 'failing' | 'unknown' */
      t.string('last_status', 20).notNullable().defaultTo('unknown')
      t.dateTime('last_checked_at').nullable()
      t.text('last_detail').nullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable()
      t.dateTime('updated_at').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_monitors')
}
