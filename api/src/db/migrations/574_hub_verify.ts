import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub verification: post-deploy smoke checks and the extension version manager
 * (services/hub/verify/*). Created on every install, used only in hub mode. No foreign keys;
 * each table is skipped when it already exists.
 *
 *  - nivaro_hub_smoke_suites        one per environment: the saved checks (JSON), what a failure
 *                                   does (notify | rollback through the automatic rollback rule)
 *  - nivaro_hub_smoke_runs          one per run of a suite: after a deploy, a move, a shared
 *                                   upgrade, or by hand. `source_key` names what started it
 *                                   (deploy:12, move:3, shared:4, manual:<uuid>) so a tick never
 *                                   queues the same one twice
 *  - nivaro_hub_extension_sightings what each environment last reported for an extension
 *                                   (version, build, status) and what the Hub pins for it there
 *  - nivaro_hub_extension_promotions one row per extension promoted on its own
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_hub_smoke_suites'))) {
    await knex.schema.createTable('nivaro_hub_smoke_suites', (t) => {
      t.increments('id').primary()
      t.integer('environment_id').notNullable()
      t.boolean('enabled').notNullable().defaultTo(true)
      t.string('on_fail', 16).notNullable().defaultTo('notify')
      t.integer('settle_seconds').notNullable().defaultTo(30)
      longText(t, knex, 'checks').notNullable()
      t.uuid('updated_by').nullable()
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['environment_id'], { indexName: 'ux_nivaro_hub_smoke_suite_env' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_smoke_runs'))) {
    await knex.schema.createTable('nivaro_hub_smoke_runs', (t) => {
      t.increments('id').primary()
      t.integer('app_id').notNullable()
      t.integer('environment_id').notNullable()
      t.string('source_key', 80).notNullable()
      t.string('trigger_kind', 16).notNullable()
      t.integer('deploy_id').nullable()
      t.string('version', 64).nullable()
      t.string('status', 16).notNullable().defaultTo('queued')
      t.string('on_fail', 16).nullable()
      longText(t, knex, 'checks').nullable()
      longText(t, knex, 'results').nullable()
      t.integer('passed').nullable()
      t.integer('failed').nullable()
      t.string('reason', 1000).nullable()
      t.dateTime('due_at').notNullable()
      t.dateTime('claimed_at').nullable()
      t.dateTime('started_at').nullable()
      t.dateTime('finished_at').nullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.unique(['source_key'], { indexName: 'ux_nivaro_hub_smoke_run_source' })
      t.index(['status', 'due_at'], 'ix_nivaro_hub_smoke_runs_due')
      t.index(['environment_id', 'id'], 'ix_nivaro_hub_smoke_runs_env')
      t.index(['deploy_id'], 'ix_nivaro_hub_smoke_runs_deploy')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_extension_sightings'))) {
    await knex.schema.createTable('nivaro_hub_extension_sightings', (t) => {
      t.increments('id').primary()
      t.integer('environment_id').notNullable()
      t.string('extension_id', 64).notNullable()
      t.string('version', 64).nullable()
      t.string('build', 80).nullable()
      t.string('status', 16).nullable()
      t.boolean('enabled').nullable()
      t.string('pin', 300).nullable()
      t.string('pin_source', 16).nullable()
      t.dateTime('seen_at').nullable()
      t.dateTime('pin_read_at').nullable()
      t.unique(['environment_id', 'extension_id'], { indexName: 'ux_nivaro_hub_ext_sight' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_extension_promotions'))) {
    await knex.schema.createTable('nivaro_hub_extension_promotions', (t) => {
      t.increments('id').primary()
      t.integer('app_id').notNullable()
      t.integer('environment_id').notNullable()
      t.string('extension_id', 64).notNullable()
      t.integer('from_environment_id').nullable()
      t.string('from_pin', 300).nullable()
      t.string('to_pin', 300).notNullable()
      t.string('via', 16).notNullable()
      t.string('status', 16).notNullable().defaultTo('started')
      t.integer('deploy_id').nullable()
      t.string('commit_sha', 64).nullable()
      t.string('error', 1000).nullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('finished_at').nullable()
      t.index(['environment_id', 'id'], 'ix_nivaro_hub_ext_promo_env')
      t.index(['app_id'], 'ix_nivaro_hub_ext_promo_app')
    })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: tables may hold live hub data.
}
