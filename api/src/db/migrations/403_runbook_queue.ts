import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Host runbooks (#720 follow-up) — a runbook an extension declares with
 * `runs_on: 'host'` is queued from the admin console of ANY instance and run
 * by the host agent (`pnpm runbook:agent --once` from cron on the machine
 * that can reach what the runbook needs, e.g. the SQL Server box), which
 * streams its output back here.
 *
 *   nivaro_runbook_queue — one row per requested run: mode dry|go, target,
 *     the phase it starts from, status queued|running|done|failed|cancelled|
 *     refused|lost, which host claimed it, heartbeat, cancel request, the
 *     step events the run reported (JSON array, the local runner's shape).
 *     requested_by is a bare uuid (NO FK — history outlives a deleted user).
 *   nivaro_runbook_queue_lines — the run's output, one row per line, seq
 *     per run (the console polls `seq > n`).
 *   nivaro_runbook_agents — one row per host agent: last check-in, version,
 *     which runbooks it can run, the run it is supervising.
 *   nivaro_runbook_step_timings — how long each phase (parent_step NULL) and
 *     each sub-step of a phase took on every SUCCESSFUL pass, from queued
 *     runs (source 'queue', run_ref = the queue id) and from the runbook's
 *     own history logs harvested by the agent (source 'nightly', run_ref =
 *     the log directory). max_quiet_secs = the longest stretch without
 *     output seen in that phase (queue runs only) — the console's stall
 *     threshold. Medians of these are the console's estimates.
 *
 * Per-database runtime: never promoted, never compared.
 */
const QUEUE = 'nivaro_runbook_queue'
const LINES = 'nivaro_runbook_queue_lines'
const AGENTS = 'nivaro_runbook_agents'
const TIMINGS = 'nivaro_runbook_step_timings'

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(QUEUE))) {
    await knex.schema.createTable(QUEUE, (t) => {
      t.uuid('id').primary()
      t.string('extension', 120).notNullable()
      t.string('runbook', 120).notNullable()
      t.string('mode', 8).notNullable()
      t.string('target', 128).nullable()
      t.text('args').nullable()
      t.string('from_step', 64).nullable()
      t.uuid('resume_of').nullable()
      t.string('status', 16).notNullable().defaultTo('queued')
      t.uuid('requested_by').nullable()
      t.datetime('requested_at').notNullable().defaultTo(utcNow(knex))
      t.string('host', 200).nullable()
      t.datetime('claimed_at').nullable()
      t.datetime('started_at').nullable()
      t.datetime('finished_at').nullable()
      t.datetime('heartbeat_at').nullable()
      t.string('failed_step', 64).nullable()
      t.string('summary', 1000).nullable()
      t.boolean('cancel_requested').notNullable().defaultTo(false)
      t.text('events').nullable()
      t.index(['status', 'requested_at'], 'ix_runbook_queue_status')
      t.index(['extension', 'runbook', 'requested_at'], 'ix_runbook_queue_runbook')
    })
  }
  if (!(await knex.schema.hasTable(LINES))) {
    await knex.schema.createTable(LINES, (t) => {
      t.bigIncrements('id').primary()
      t.uuid('run_id').notNullable()
      t.integer('seq').notNullable()
      t.string('line', 2000).notNullable() // nvarchar(2000) on SQL Server
      t.datetime('at').notNullable().defaultTo(utcNow(knex))
      t.index(['run_id', 'seq'], 'ix_runbook_queue_lines_run')
    })
  }
  if (!(await knex.schema.hasTable(AGENTS))) {
    await knex.schema.createTable(AGENTS, (t) => {
      t.string('host', 200).primary()
      t.datetime('last_seen').notNullable().defaultTo(utcNow(knex))
      t.string('version', 60).nullable()
      t.text('runbooks').nullable()
      t.uuid('busy_run').nullable()
    })
  }
  if (!(await knex.schema.hasTable(TIMINGS))) {
    await knex.schema.createTable(TIMINGS, (t) => {
      t.bigIncrements('id').primary()
      t.string('extension', 120).notNullable()
      t.string('runbook', 120).notNullable()
      t.string('step', 120).notNullable()
      t.string('parent_step', 120).nullable()
      t.string('mode', 8).notNullable()
      t.integer('secs').notNullable()
      t.integer('max_quiet_secs').nullable()
      t.datetime('finished_at').notNullable()
      t.string('source', 16).notNullable()
      t.string('run_ref', 200).notNullable()
      t.datetime('created_at').notNullable().defaultTo(utcNow(knex))
      t.index(['extension', 'runbook', 'finished_at'], 'ix_runbook_step_timings_runbook')
      t.index(['source', 'run_ref'], 'ix_runbook_step_timings_ref')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const t of [LINES, QUEUE, AGENTS, TIMINGS])
    if (await knex.schema.hasTable(t)) await knex.schema.dropTable(t)
}
