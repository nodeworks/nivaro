import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub release operations: release trains, scheduled promotions, freeze windows,
 * automatic rollback rules and their watches, release notes per run, and the build facts the
 * Hub learned per Nivaro version (services/hub/releases/*). Created on every install, used only
 * in hub mode. No foreign keys; each table is skipped when it already exists.
 *
 *  - nivaro_hub_trains          one row per release train (steps JSON: one per environment, in
 *                               order, each a normal promotion run + a hold)
 *  - nivaro_hub_schedules       a promotion or a train to start at run_at (UTC)
 *  - nivaro_hub_freezes         freeze windows, per app (app_id) or Hub-wide (app_id null);
 *                               once (starts_at..ends_at) or every month end (recurrence month_end)
 *  - nivaro_hub_rollback_rules  per environment: roll back automatically when the figures cross
 *  - nivaro_hub_rollback_watches one row per successful promotion watched under a rule
 *  - nivaro_hub_release_notes   what changed in a run (commits, migrations, new settings)
 *  - nivaro_hub_version_facts   per Nivaro version: its migration names and known settings
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_hub_trains'))) {
    await knex.schema.createTable('nivaro_hub_trains', (t) => {
      t.increments('id').primary()
      t.integer('app_id').notNullable()
      t.string('version', 64).notNullable()
      t.string('status', 16).notNullable().defaultTo('running')
      longText(t, knex, 'steps').notNullable()
      t.integer('step_index').notNullable().defaultTo(0)
      t.integer('rev').notNullable().defaultTo(0)
      t.string('error', 1000).nullable()
      t.integer('schedule_id').nullable()
      t.uuid('started_by').nullable()
      t.dateTime('started_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable()
      t.dateTime('finished_at').nullable()
      t.index(['app_id'], 'ix_nivaro_hub_trains_app')
      t.index(['status'], 'ix_nivaro_hub_trains_status')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_schedules'))) {
    await knex.schema.createTable('nivaro_hub_schedules', (t) => {
      t.increments('id').primary()
      t.integer('app_id').notNullable()
      t.integer('environment_id').nullable()
      t.string('kind', 16).notNullable()
      t.string('version', 64).notNullable()
      t.dateTime('run_at').notNullable()
      t.string('on_freeze', 8).notNullable().defaultTo('wait')
      longText(t, knex, 'train').nullable()
      t.string('status', 16).notNullable().defaultTo('scheduled')
      t.integer('attempts').notNullable().defaultTo(0)
      // The last time it was held back (a freeze's end, a passing refusal): the 6-hour missed
      // rule counts from here as well as from run_at.
      t.dateTime('wait_until').nullable()
      // When the current claim was taken (a claim older than 5 minutes was left by a stopped tick).
      t.dateTime('claimed_at').nullable()
      t.string('note', 500).nullable()
      t.integer('deploy_id').nullable()
      t.integer('train_id').nullable()
      t.string('error', 1000).nullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('started_at').nullable()
      t.index(['status', 'run_at'], 'ix_nivaro_hub_schedules_due')
      t.index(['app_id'], 'ix_nivaro_hub_schedules_app')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_freezes'))) {
    await knex.schema.createTable('nivaro_hub_freezes', (t) => {
      t.increments('id').primary()
      t.integer('app_id').nullable()
      t.string('name', 120).notNullable()
      t.string('recurrence', 16).notNullable().defaultTo('none')
      t.dateTime('starts_at').nullable()
      t.dateTime('ends_at').nullable()
      t.integer('days_before').nullable()
      t.integer('days_after').nullable()
      t.string('time_zone', 64).nullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable()
      t.index(['app_id'], 'ix_nivaro_hub_freezes_app')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_rollback_rules'))) {
    await knex.schema.createTable('nivaro_hub_rollback_rules', (t) => {
      t.increments('id').primary()
      t.integer('environment_id').notNullable()
      t.boolean('enabled').notNullable().defaultTo(true)
      t.integer('window_minutes').notNullable().defaultTo(30)
      t.decimal('max_error_pct', 6, 2).nullable()
      t.integer('min_requests').notNullable().defaultTo(50)
      t.integer('max_crashes').nullable()
      t.integer('min_readiness').nullable()
      t.uuid('updated_by').nullable()
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['environment_id'], { indexName: 'ux_nivaro_hub_rbrules_env' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_rollback_watches'))) {
    await knex.schema.createTable('nivaro_hub_rollback_watches', (t) => {
      t.increments('id').primary()
      t.integer('deploy_id').notNullable()
      t.integer('app_id').notNullable()
      t.integer('environment_id').notNullable()
      t.string('version', 64).notNullable()
      t.string('from_version', 64).nullable()
      t.string('status', 16).notNullable().defaultTo('watching')
      longText(t, knex, 'rule_json').nullable()
      longText(t, knex, 'figures').nullable()
      t.string('reason', 1000).nullable()
      t.dateTime('deployed_at').nullable()
      t.dateTime('until_at').nullable()
      t.dateTime('last_check_at').nullable()
      t.integer('rollback_deploy_id').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('finished_at').nullable()
      t.unique(['deploy_id'], { indexName: 'ux_nivaro_hub_rbwatch_deploy' })
      t.index(['status'], 'ix_nivaro_hub_rbwatch_status')
      t.index(['environment_id'], 'ix_nivaro_hub_rbwatch_env')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_release_notes'))) {
    await knex.schema.createTable('nivaro_hub_release_notes', (t) => {
      t.increments('id').primary()
      t.integer('deploy_id').notNullable()
      longText(t, knex, 'notes').notNullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.unique(['deploy_id'], { indexName: 'ux_nivaro_hub_relnotes_deploy' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_version_facts'))) {
    await knex.schema.createTable('nivaro_hub_version_facts', (t) => {
      t.increments('id').primary()
      t.string('version', 64).notNullable()
      longText(t, knex, 'migrations').nullable()
      longText(t, knex, 'env_keys').nullable()
      t.string('source', 64).nullable()
      t.dateTime('seen_at').nullable().defaultTo(utcNow(knex))
      t.unique(['version'], { indexName: 'ux_nivaro_hub_vfacts_version' })
    })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: tables may hold live hub data.
}
