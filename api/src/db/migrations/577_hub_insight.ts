import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub insight (enhancements 36–40): usage aggregates, dependency snapshots, health score
 * history and the weekly owner digest. Created on every install, used only in hub mode (HUB=on),
 * empty otherwise. No foreign keys; each table is skipped when it already exists. Unique indexes
 * are declared in createTable (portable on all five engines).
 *
 *  - nivaro_hub_usage_days     one row per environment per UTC day: how many different people used
 *                              the app that day and how many screens they opened — counts only,
 *                              read over the hub link; a day under the app's privacy floor (fewer
 *                              than 5 people) arrives as `under_floor` with no figures at all
 *  - nivaro_hub_usage_screens  the busiest screens (route patterns, never ids) of an environment
 *                              over its last collect window, each with ≥ floor people; replaced on
 *                              every collect
 *  - nivaro_hub_dependencies   what an environment depends on: partner API hosts, webhook hosts,
 *                              the mail relay, sign-in issuer, issue trackers, extensions, its
 *                              database server, shared deployment and driver — HOSTS only, never
 *                              a path, a query or a credential; replaced on every collect
 *  - nivaro_hub_insight_state  one row per environment: when usage / dependencies were last read
 *                              and how that went (a fixed state word, never the app's text)
 *  - nivaro_hub_health_scores  one row per environment per UTC day: the 0–100 health score and its
 *                              parts (the last computation of that day wins)
 *  - nivaro_hub_digest_prefs   one row per person who changed their weekly digest switch
 *  - nivaro_hub_digest_sends   one row per person per ISO week a digest went out (never twice)
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_hub_usage_days'))) {
    await knex.schema.createTable('nivaro_hub_usage_days', (t) => {
      t.increments('id').primary()
      t.integer('environment_id').notNullable()
      t.integer('app_id').notNullable()
      t.string('day', 10).notNullable()
      t.integer('people').nullable()
      t.integer('views').nullable()
      t.boolean('under_floor').notNullable().defaultTo(false)
      t.integer('accounts').nullable()
      t.dateTime('collected_at').nullable().defaultTo(utcNow(knex))
      t.unique(['environment_id', 'day'], { indexName: 'ux_nivaro_hub_usage_days_env_day' })
      t.index(['day'], 'ix_nivaro_hub_usage_days_day')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_usage_screens'))) {
    await knex.schema.createTable('nivaro_hub_usage_screens', (t) => {
      t.increments('id').primary()
      t.integer('environment_id').notNullable()
      t.string('route', 300).notNullable()
      t.integer('people').notNullable()
      t.integer('views').notNullable()
      t.integer('period_days').notNullable()
      t.dateTime('collected_at').nullable().defaultTo(utcNow(knex))
      t.index(['environment_id'], 'ix_nivaro_hub_usage_screens_env')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_dependencies'))) {
    await knex.schema.createTable('nivaro_hub_dependencies', (t) => {
      t.increments('id').primary()
      t.integer('environment_id').notNullable()
      t.string('kind', 24).notNullable()
      t.string('target', 255).notNullable()
      t.string('label', 200).nullable()
      t.string('detail', 500).nullable()
      t.string('source', 8).notNullable().defaultTo('app')
      t.dateTime('seen_at').nullable().defaultTo(utcNow(knex))
      t.index(['environment_id'], 'ix_nivaro_hub_dependencies_env')
      t.index(['kind', 'target'], 'ix_nivaro_hub_dependencies_target')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_insight_state'))) {
    await knex.schema.createTable('nivaro_hub_insight_state', (t) => {
      t.increments('id').primary()
      t.integer('environment_id').notNullable()
      t.string('usage_state', 16).nullable()
      t.dateTime('usage_at').nullable()
      t.integer('people_7d').nullable()
      t.integer('people_window').nullable()
      t.integer('accounts').nullable()
      t.integer('screens_hidden').nullable()
      t.string('deps_state', 16).nullable()
      t.dateTime('deps_at').nullable()
      t.unique(['environment_id'], { indexName: 'ux_nivaro_hub_insight_state_env' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_health_scores'))) {
    await knex.schema.createTable('nivaro_hub_health_scores', (t) => {
      t.increments('id').primary()
      t.integer('environment_id').notNullable()
      t.integer('app_id').notNullable()
      t.string('day', 10).notNullable()
      t.integer('score').nullable()
      longText(t, knex, 'parts').nullable()
      t.dateTime('computed_at').nullable().defaultTo(utcNow(knex))
      t.unique(['environment_id', 'day'], { indexName: 'ux_nivaro_hub_health_env_day' })
      t.index(['day'], 'ix_nivaro_hub_health_day')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_digest_prefs'))) {
    await knex.schema.createTable('nivaro_hub_digest_prefs', (t) => {
      t.increments('id').primary()
      t.uuid('user_id').notNullable()
      t.boolean('enabled').notNullable().defaultTo(true)
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['user_id'], { indexName: 'ux_nivaro_hub_digest_prefs_user' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_digest_sends'))) {
    await knex.schema.createTable('nivaro_hub_digest_sends', (t) => {
      t.increments('id').primary()
      t.uuid('user_id').notNullable()
      t.string('week', 10).notNullable()
      t.integer('apps').notNullable().defaultTo(0)
      t.string('status', 16).notNullable().defaultTo('sent')
      t.dateTime('sent_at').nullable().defaultTo(utcNow(knex))
      t.unique(['user_id', 'week'], { indexName: 'ux_nivaro_hub_digest_sends_user_week' })
    })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: tables may hold live hub data.
}
