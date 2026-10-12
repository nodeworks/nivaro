import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Migration 442 — log alerts from questions, and incident threads.
 *
 *  - nivaro_log_alert_rules gains `filters` (JSON: the same filter object
 *    "Ask the logs" compiles, #1914/#1960 — a rule over the request log
 *    instead of a regex over the log ring), `threshold` + `window_minutes`
 *    (fire when this many matches land inside the window; NULL = every
 *    match, the old behaviour), `cooldown_minutes` (NULL = 5) and `origin`
 *    ('manual' | 'ask' | 'suggested', #2013).
 *  - nivaro_settings.ops_channel: the admin-only chat channel (room key
 *    `ch:<key>`) incident threads open in (#2016).
 *  - chat_messages.ops_only (LEGACY table, guarded ALTER): an assistant ops
 *    post — hidden from anyone who is not an administrator, and a channel
 *    holding one only admits administrators (services/ops-room-guard.ts).
 *  - nivaro_ops_incidents: one row per incident thread — incident mode or a
 *    critical alert — with the room and root message the updates reply
 *    under, what was last reported and the closing summary.
 *
 * Idempotent: every step checks before it creates.
 */
export async function up(knex: Knex): Promise<void> {
  const rules = 'nivaro_log_alert_rules'
  if (await knex.schema.hasTable(rules)) {
    for (const [col, add] of [
      ['filters', (t: Knex.AlterTableBuilder) => t.text('filters').nullable()],
      ['threshold', (t: Knex.AlterTableBuilder) => t.integer('threshold').nullable()],
      ['window_minutes', (t: Knex.AlterTableBuilder) => t.integer('window_minutes').nullable()],
      ['cooldown_minutes', (t: Knex.AlterTableBuilder) => t.integer('cooldown_minutes').nullable()],
      ['origin', (t: Knex.AlterTableBuilder) => t.string('origin', 20).nullable()]
    ] as const) {
      if (!(await knex.schema.hasColumn(rules, col))) {
        await knex.schema.alterTable(rules, (t) => {
          add(t)
        })
      }
    }
  }
  if (
    (await knex.schema.hasTable('nivaro_settings')) &&
    !(await knex.schema.hasColumn('nivaro_settings', 'ops_channel'))
  ) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.string('ops_channel', 200).nullable()
    })
  }
  if (
    (await knex.schema.hasTable('chat_messages')) &&
    !(await knex.schema.hasColumn('chat_messages', 'ops_only'))
  ) {
    await knex.schema.alterTable('chat_messages', (t) => {
      t.boolean('ops_only').nullable()
    })
  }
  if (!(await knex.schema.hasTable('nivaro_ops_incidents'))) {
    await knex.schema.createTable('nivaro_ops_incidents', (t) => {
      t.increments('id').primary()
      /** 'incident' = incident mode; 'alert' = a critical alert's thread. */
      t.string('kind', 20).notNullable()
      t.string('title', 300).notNullable()
      t.string('status', 20).notNullable().defaultTo('open')
      /** Dedupe key for alert threads (signal id, issue fingerprint). */
      t.string('source_key', 200).nullable()
      t.string('room', 200).nullable()
      t.integer('root_message_id').nullable()
      t.uuid('started_by').nullable()
      t.datetime('started_at').notNullable().defaultTo(utcNow(knex))
      t.uuid('ended_by').nullable()
      t.datetime('ended_at').nullable()
      t.datetime('last_update_at').nullable()
      /** JSON: what the last update reported (error counts, issue ids seen, actions). */
      t.text('state').nullable()
      t.text('summary').nullable()
      t.index(['status'], 'ix_ops_incidents_status')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_ops_incidents')) {
    await knex.schema.dropTable('nivaro_ops_incidents')
  }
  if (await knex.schema.hasColumn('chat_messages', 'ops_only')) {
    await knex.schema.alterTable('chat_messages', (t) => {
      t.dropColumn('ops_only')
    })
  }
  if (await knex.schema.hasColumn('nivaro_settings', 'ops_channel')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('ops_channel')
    })
  }
  for (const col of ['filters', 'threshold', 'window_minutes', 'cooldown_minutes', 'origin']) {
    if (await knex.schema.hasColumn('nivaro_log_alert_rules', col)) {
      await knex.schema.alterTable('nivaro_log_alert_rules', (t) => {
        t.dropColumn(col)
      })
    }
  }
}
