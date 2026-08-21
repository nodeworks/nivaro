import type { Knex } from 'knex'

/**
 * Unified background-execution log: every cron tick, readiness remediation,
 * materialization backfill, and rollup recalc lands here, so the Background
 * Jobs console (and per-extension health) reads one table instead of five
 * ad-hoc sources. High-frequency crons are pruned hard by the daily retention
 * pass (newest N per job + age cap) — history is for triage, not archaeology.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_job_runs'))) {
    await knex.schema.createTable('nivaro_job_runs', (t) => {
      t.increments('id')
      /** 'cron' | 'remediation' | 'backfill' | 'recalc' | 'monitor' */
      t.string('kind', 30).notNullable()
      /** Cron id / readiness check id / queue id / collection.field */
      t.string('job_id', 200).notNullable()
      t.string('label', 300).nullable()
      t.string('extension_id', 100).nullable()
      /** 'running' | 'completed' | 'error' */
      t.string('status', 20).notNullable().defaultTo('running')
      t.dateTime('started_at').notNullable()
      t.dateTime('finished_at').nullable()
      t.integer('duration_ms').nullable()
      /** Short human outcome ("swept 374 relations, 0 dangling"). */
      t.text('outcome').nullable()
      t.text('error').nullable()
      /** JSON progress blob for long jobs the console polls. */
      t.text('progress').nullable()
      /** Who triggered a manual run; null = the schedule itself. */
      t.uuid('triggered_by').nullable()
      t.index(['kind', 'job_id', 'id'])
      t.index(['started_at'])
      t.index(['status'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_job_runs')
}
