import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub fleet view: the last thing the Hub saw of each environment, uptime samples, version
 * drift alerts and the monthly SLO reports. Created on every install, used only in hub mode
 * (HUB=on), empty otherwise. No foreign keys; each table is skipped when it already exists.
 * Unique indexes are declared in createTable (portable on all five engines).
 *
 *  - nivaro_hub_fleet_status    one row per environment: the newest status the probe job read
 *                               (state, version, preflight, readiness score, open issues) and
 *                               `version_since` = when that version was first seen
 *  - nivaro_hub_uptime_samples  one row per probe of an environment's public /api/version (and
 *                               /api/ready); pruned after 45 days by cron hub-fleet-prune
 *  - nivaro_hub_fleet_alerts    one row per opened drift alert (rule + subject); resolved_at set
 *                               when the rule stops firing, notified_at once people were told
 *  - nivaro_hub_slo_reports     one row per environment per month (uptime + target, basis points)
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_hub_fleet_status'))) {
    await knex.schema.createTable('nivaro_hub_fleet_status', (t) => {
      t.increments('id').primary()
      t.integer('environment_id').notNullable()
      t.integer('app_id').notNullable()
      t.string('state', 16).nullable()
      t.string('version', 64).nullable()
      t.dateTime('version_since').nullable()
      t.string('preflight', 16).nullable()
      t.integer('readiness_score').nullable()
      t.integer('open_issues').nullable()
      t.string('source', 16).nullable()
      t.string('error', 200).nullable()
      longText(t, knex, 'failing').nullable()
      t.dateTime('checked_at').nullable()
      t.boolean('up').nullable()
      t.dateTime('probed_at').nullable()
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['environment_id'], { indexName: 'ux_nivaro_hub_fleet_status_env' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_uptime_samples'))) {
    await knex.schema.createTable('nivaro_hub_uptime_samples', (t) => {
      t.increments('id').primary()
      t.integer('environment_id').notNullable()
      t.dateTime('at').notNullable()
      t.boolean('up').notNullable()
      t.boolean('version_ok').notNullable()
      t.boolean('ready').nullable()
      t.integer('ms').nullable()
      t.string('code', 32).nullable()
      t.index(['environment_id', 'at'], 'ix_nivaro_hub_uptime_env_at')
      t.index(['at'], 'ix_nivaro_hub_uptime_at')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_fleet_alerts'))) {
    await knex.schema.createTable('nivaro_hub_fleet_alerts', (t) => {
      t.increments('id').primary()
      t.string('rule_id', 64).notNullable()
      t.string('kind', 24).notNullable()
      t.string('subject_key', 200).notNullable()
      t.integer('app_id').notNullable()
      t.integer('environment_id').nullable()
      t.string('message', 1000).notNullable()
      t.dateTime('opened_at').notNullable()
      t.dateTime('last_seen_at').notNullable()
      t.dateTime('resolved_at').nullable()
      t.dateTime('notified_at').nullable()
      t.index(['resolved_at'], 'ix_nivaro_hub_fleet_alerts_open')
      t.index(['rule_id', 'subject_key'], 'ix_nivaro_hub_fleet_alerts_rule')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_slo_reports'))) {
    await knex.schema.createTable('nivaro_hub_slo_reports', (t) => {
      t.increments('id').primary()
      t.string('month', 7).notNullable()
      t.integer('app_id').notNullable()
      t.integer('environment_id').notNullable()
      t.integer('samples').notNullable()
      t.integer('up_samples').notNullable()
      t.integer('uptime_bp').nullable()
      t.integer('target_bp').notNullable()
      t.boolean('met').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('sent_at').nullable()
      t.unique(['month', 'environment_id'], { indexName: 'ux_nivaro_hub_slo_month_env' })
    })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: tables may hold live hub data.
}
