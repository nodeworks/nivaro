import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Chaos engineering (#2827): runs, their timelines and saved presets.
 *
 *   nivaro_chaos_runs        RUNTIME — one row per drill / monkey pick / game-day step / CI run;
 *                            the hypothesis, baseline and verdict ride as JSON text
 *   nivaro_chaos_run_events  RUNTIME — the run's timeline (armed, sample, alert, readiness,
 *                            note, abort, stop, step), compact JSON per row
 *   nivaro_chaos_presets     CONFIG  — saved scenarios (#2855), promoted between instances
 *
 * Guarded and additive. Without these tables the chaos services keep runs in Redis
 * (`nvr:chaos:run:*`, 7 days) so the console works on a database behind this migration.
 * FKs are NO ACTION (project rule); user references are uuid.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_chaos_runs'))) {
    await knex.schema.createTable('nivaro_chaos_runs', (t) => {
      t.uuid('id').primary()
      t.string('kind', 16).notNullable().defaultTo('drill')
      t.string('status', 16).notNullable().defaultTo('planned')
      t.string('fault_key', 64).nullable()
      t.string('label', 200).nullable()
      t.text('target').nullable()
      t.text('params').nullable()
      t.text('hypothesis').nullable()
      t.string('verdict', 12).nullable()
      t.text('verdict_detail').nullable()
      t.text('baseline').nullable()
      t.uuid('started_by').nullable().references('id').inTable('nivaro_users')
      t.datetime('started_at').nullable()
      t.datetime('ends_at').nullable()
      t.datetime('ended_at').nullable()
      t.uuid('preset_id').nullable()
      t.uuid('gameday_id').nullable()
      t.text('meta', 'longtext').nullable()
      t.datetime('created_at').notNullable().defaultTo(utcNow(knex))
      t.index(['started_at'], 'ix_nivaro_chaos_runs_started')
      t.index(['fault_key', 'started_at'], 'ix_nivaro_chaos_runs_fault')
      t.index(['status'], 'ix_nivaro_chaos_runs_status')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_chaos_run_events'))) {
    await knex.schema.createTable('nivaro_chaos_run_events', (t) => {
      t.bigIncrements('id').primary()
      t.uuid('run_id').notNullable().references('id').inTable('nivaro_chaos_runs')
      t.datetime('at').notNullable().defaultTo(utcNow(knex))
      t.string('kind', 16).notNullable()
      t.uuid('actor').nullable()
      t.text('data').nullable()
      t.index(['run_id', 'id'], 'ix_nivaro_chaos_run_events_run')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_chaos_presets'))) {
    await knex.schema.createTable('nivaro_chaos_presets', (t) => {
      t.uuid('id').primary()
      t.string('key', 80).notNullable().unique('ux_nivaro_chaos_presets_key')
      t.string('label', 200).notNullable()
      t.text('description').nullable()
      t.text('proves').nullable()
      t.text('claim_keys').nullable()
      t.text('spec', 'longtext').nullable()
      t.uuid('created_by').nullable()
      t.datetime('updated_at').notNullable().defaultTo(utcNow(knex))
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['nivaro_chaos_run_events', 'nivaro_chaos_presets', 'nivaro_chaos_runs']) {
    if (await knex.schema.hasTable(table)) await knex.schema.dropTable(table)
  }
}
