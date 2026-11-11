import type { Knex } from 'knex'

/**
 * Daily operations report (2026-11-10).
 *
 *   nivaro_ops_reports — one row per run (a day can be re-run; the page shows the newest per day)
 *     id            increments PK
 *     day           varchar(10)  instance day YYYY-MM-DD
 *     status        varchar(20)  running | ready | digest_only | failed
 *     verdict       varchar(12)  healthy | watch | bad (null while running)
 *     score         int          0–100 health score from the numbers (no AI)
 *     headline      nvarchar(400)
 *     trigger       varchar(12)  cron | manual
 *     window_start / window_end   datetime2 (UTC)
 *     tz            varchar(64)  instance time zone the window was cut in
 *     model         varchar(120), tokens_in / tokens_out int, cost_usd decimal(12,4)
 *     kpis / digest / analysis / tracker / comparison / tools   nvarchar(max) JSON
 *     error         nvarchar(1000)
 *     created_by    uniqueidentifier NULL (no FK — a run outlives its starter)
 *     created_at / finished_at   datetime2
 *   index (day DESC, id DESC)
 *
 * Runtime table (never copied by config promotion). Additive and guarded.
 */
const TABLE = 'nivaro_ops_reports'

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) return
  await knex.schema.createTable(TABLE, (t) => {
    t.increments('id').primary()
    t.string('day', 10).notNullable()
    t.string('status', 20).notNullable().defaultTo('running')
    t.string('verdict', 12).nullable()
    t.integer('score').nullable()
    t.string('headline', 400).nullable()
    t.string('trigger', 12).notNullable().defaultTo('manual')
    t.datetime('window_start').notNullable()
    t.datetime('window_end').notNullable()
    t.string('tz', 64).notNullable().defaultTo('UTC')
    t.string('model', 120).nullable()
    t.integer('tokens_in').nullable()
    t.integer('tokens_out').nullable()
    t.decimal('cost_usd', 12, 4).nullable()
    t.text('kpis').nullable()
    t.text('digest').nullable()
    t.text('analysis').nullable()
    t.text('tracker').nullable()
    t.text('comparison').nullable()
    t.text('tools').nullable()
    t.string('error', 1000).nullable()
    t.uuid('created_by').nullable()
    t.datetime('created_at').notNullable()
    t.datetime('finished_at').nullable()
    t.index(['day', 'id'], 'ix_ops_reports_day')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(TABLE)
}
