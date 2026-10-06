import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Staging quality checks — compare a freshly converted database against
 * numbers captured from the legacy shape right after it was cloned.
 *
 *   nivaro_quality_runs    — one row per capture/verify cycle for a target.
 *   nivaro_quality_rows    — per check and side (baseline|current|diff) the
 *     gz JSON row list. `diff` = every non-matching DiffRow of the last diff.
 *   nivaro_quality_results — per check verdict (green|amber|red|error) with
 *     counts, clusters and up to 500 sample rows.
 *   nivaro_quality_known   — curated known differences (config; promoted).
 *
 * runs/rows/results are per-database runtime; known is config.
 */
const RUNS = 'nivaro_quality_runs'
const ROWS = 'nivaro_quality_rows'
const RESULTS = 'nivaro_quality_results'
const KNOWN = 'nivaro_quality_known'

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(RUNS))) {
    await knex.schema.createTable(RUNS, (t) => {
      t.uuid('id').primary()
      t.string('target', 128).notNullable()
      t.string('runbook_run', 36).nullable()
      t.string('status', 16).notNullable().defaultTo('capturing')
      t.datetime('started_at').notNullable().defaultTo(utcNow(knex))
      t.datetime('captured_at').nullable()
      t.datetime('verified_at').nullable()
      // When the latest verify stage began; a run 'verifying' for over two
      // hours past it is stale (its runner was killed).
      t.datetime('verify_started_at').nullable()
      t.text('totals').nullable()
      t.string('error', 2000).nullable()
      t.uuid('created_by').nullable()
      t.index(['target', 'started_at'], 'ix_quality_runs_target')
    })
  }
  if (!(await knex.schema.hasTable(ROWS))) {
    await knex.schema.createTable(ROWS, (t) => {
      t.increments('id')
      t.uuid('run').notNullable().references('id').inTable(RUNS).onDelete('CASCADE')
      t.string('check_id', 100).notNullable()
      t.string('side', 8).notNullable()
      t.text('rows_gz', 'longtext').nullable()
      t.integer('row_count').notNullable().defaultTo(0)
      t.integer('duration_ms').nullable()
      t.string('error', 2000).nullable()
      t.datetime('created_at').defaultTo(utcNow(knex))
      t.unique(['run', 'check_id', 'side'], { indexName: 'ux_quality_rows' })
    })
  }
  if (!(await knex.schema.hasTable(RESULTS))) {
    await knex.schema.createTable(RESULTS, (t) => {
      t.increments('id')
      t.uuid('run').notNullable().references('id').inTable(RUNS).onDelete('CASCADE')
      t.string('check_id', 100).notNullable()
      t.string('area', 32).notNullable()
      t.string('label', 200).notNullable()
      t.string('description', 1000).nullable()
      t.string('status', 8).notNullable()
      t.string('tolerance', 100).nullable()
      t.integer('compared').notNullable().defaultTo(0)
      t.integer('matched').notNullable().defaultTo(0)
      t.integer('amber_count').notNullable().defaultTo(0)
      t.integer('red_count').notNullable().defaultTo(0)
      t.integer('baseline_only').notNullable().defaultTo(0)
      t.integer('current_only').notNullable().defaultTo(0)
      t.integer('duration_ms').nullable()
      t.string('error', 2000).nullable()
      t.text('clusters').nullable()
      t.text('rows', 'longtext').nullable()
      t.datetime('computed_at').defaultTo(utcNow(knex))
      t.unique(['run', 'check_id'], { indexName: 'ux_quality_results' })
    })
  }
  if (!(await knex.schema.hasTable(KNOWN))) {
    await knex.schema.createTable(KNOWN, (t) => {
      t.increments('id')
      t.string('check_id', 100).notNullable()
      t.text('match').notNullable()
      t.string('reason', 1000).notNullable()
      t.uuid('created_by').nullable()
      t.datetime('created_at').defaultTo(utcNow(knex))
      t.uuid('last_matched_run').nullable()
      t.integer('matched_count').notNullable().defaultTo(0)
      t.integer('idle_runs').notNullable().defaultTo(0)
      t.index(['check_id'], 'ix_quality_known_check')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const t of [RESULTS, ROWS, KNOWN, RUNS])
    if (await knex.schema.hasTable(t)) await knex.schema.dropTable(t)
}
