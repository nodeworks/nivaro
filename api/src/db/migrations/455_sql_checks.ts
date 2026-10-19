import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Nightly SQL checks (#2562): runs, findings tracked across runs by fingerprint, the event
 * timeline per finding, and the log of fixes applied (by Nivaro when a procedure change
 * resolves a finding, or by an outside fix script). All per-database facts — RUNTIME in
 * config-inventory, never promoted. `run_by` / `accepted_by` / event `by` are bare uuids
 * (no FK): a deleted admin must never block a read.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_sql_check_runs'))) {
    await knex.schema.createTable('nivaro_sql_check_runs', (t) => {
      t.increments('id')
      t.datetime('started_at').notNullable().defaultTo(utcNow(knex))
      t.datetime('finished_at').nullable()
      t.string('status', 12).notNullable().defaultTo('running') // running | ok | failed
      t.string('trigger', 12).notNullable().defaultTo('manual') // cron | manual
      t.uuid('run_by').nullable()
      t.integer('objects_scanned').notNullable().defaultTo(0)
      t.integer('findings_total').notNullable().defaultTo(0)
      t.integer('findings_new').notNullable().defaultTo(0)
      t.integer('findings_resolved').notNullable().defaultTo(0)
      t.integer('critical_open').notNullable().defaultTo(0)
      t.integer('warning_open').notNullable().defaultTo(0)
      t.integer('info_open').notNullable().defaultTo(0)
      t.integer('duration_ms').nullable()
      t.text('error').nullable()
      t.string('sqlfluff', 12).notNullable().defaultTo('off') // on | off | unavailable
      t.text('stats').nullable() // JSON: per-check counts, skipped tables, timings
      t.index(['started_at'], 'ix_sql_check_runs_started')
    })
  }
  if (!(await knex.schema.hasTable('nivaro_sql_check_findings'))) {
    await knex.schema.createTable('nivaro_sql_check_findings', (t) => {
      t.increments('id')
      t.string('fingerprint', 64).notNullable()
      t.string('check_key', 40).notNullable()
      t.string('severity', 10).notNullable() // critical | warning | info
      t.string('object_schema', 128).nullable()
      t.string('object_name', 256).notNullable()
      t.string('object_type', 20).notNullable() // procedure | function | view | trigger | custom_query | import_definition
      t.string('object_ref', 100).nullable() // custom query / import definition id, for the editor link
      t.string('object_hash', 64).nullable() // definition hash when last seen (procedure-change detection)
      t.integer('line').nullable()
      t.string('snippet', 500).nullable()
      t.string('message', 500).notNullable()
      t.text('detail').nullable()
      t.text('suggested_fix').nullable()
      t.integer('first_seen_run').notNullable()
      t.integer('last_seen_run').notNullable()
      t.integer('seen_count').notNullable().defaultTo(1)
      t.string('status', 10).notNullable().defaultTo('open') // open | resolved | accepted
      t.datetime('first_seen_at').notNullable().defaultTo(utcNow(knex))
      t.datetime('resolved_at').nullable()
      t.uuid('accepted_by').nullable()
      t.datetime('accepted_at').nullable()
      t.string('accepted_note', 500).nullable()
      t.unique(['fingerprint'], { indexName: 'ux_sql_check_findings_fp' })
      t.index(['status', 'severity'], 'ix_sql_check_findings_status')
    })
  }
  if (!(await knex.schema.hasTable('nivaro_sql_check_events'))) {
    await knex.schema.createTable('nivaro_sql_check_events', (t) => {
      t.increments('id')
      t.integer('finding_id').notNullable()
      t.integer('run_id').nullable()
      t.string('event', 12).notNullable() // opened | resolved | reopened | accepted | unaccepted
      t.datetime('at').notNullable().defaultTo(utcNow(knex))
      t.uuid('by').nullable()
      t.string('note', 500).nullable()
      t.index(['finding_id', 'at'], 'ix_sql_check_events_finding')
    })
  }
  if (!(await knex.schema.hasTable('nivaro_sql_check_fixes'))) {
    await knex.schema.createTable('nivaro_sql_check_fixes', (t) => {
      t.increments('id')
      t.string('check_key', 40).nullable()
      t.string('target_table', 256).nullable()
      t.string('target_object', 256).nullable()
      t.string('action', 20).notNullable() // cleanup | proc_fix | guard_index | other
      t.integer('rows_affected').nullable()
      t.string('backup_table', 256).nullable()
      t.text('detail').nullable()
      t.string('run_by', 200).nullable()
      t.datetime('created_at').notNullable().defaultTo(utcNow(knex))
      t.index(['created_at'], 'ix_sql_check_fixes_created')
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_settings', 'sql_checks'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('sql_checks').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const t of [
    'nivaro_sql_check_fixes',
    'nivaro_sql_check_events',
    'nivaro_sql_check_findings',
    'nivaro_sql_check_runs'
  ])
    if (await knex.schema.hasTable(t)) await knex.schema.dropTable(t)
  if (await knex.schema.hasColumn('nivaro_settings', 'sql_checks'))
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('sql_checks')
    })
}
