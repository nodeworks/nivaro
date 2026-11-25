import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub data care: backups, restore drills, environment refreshes and move rehearsals run
 * by the Hub for the apps it looks after. Created on every install, used only in hub mode. No
 * foreign keys; each table is skipped when it already exists.
 *
 *  - nivaro_hub_backup_policies  one row per environment: database backup schedule + retention,
 *                                files backup schedule + target (+ its sealed credentials in
 *                                `target_secret`) + retention, restore drill schedule
 *  - nivaro_hub_data_runs        one row per run (kind db_backup | backup_seen | files_backup |
 *                                restore_drill | refresh | refresh_rollback | rehearsal): status,
 *                                step list, result, the artifact it left (a backup file, a
 *                                files backup set) and, for a refresh, the target's keep set
 *                                sealed in `keep_secret` until its rollback window ends
 *  - nivaro_hub_environments.refresh_target  an administrator opted this environment in as a
 *                                refresh target (default false: no environment may be written over
 *                                by a refresh until someone says so)
 */
export async function up(knex: Knex): Promise<void> {
  if (
    (await knex.schema.hasTable('nivaro_hub_environments')) &&
    !(await knex.schema.hasColumn('nivaro_hub_environments', 'refresh_target'))
  ) {
    await knex.schema.alterTable('nivaro_hub_environments', (t) => {
      t.boolean('refresh_target').notNullable().defaultTo(false)
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_backup_policies'))) {
    await knex.schema.createTable('nivaro_hub_backup_policies', (t) => {
      t.increments('id').primary()
      t.integer('environment_id').notNullable()
      t.boolean('db_enabled').notNullable().defaultTo(false)
      t.string('db_schedule', 120).nullable()
      t.string('db_path', 400).nullable()
      t.integer('db_keep_days').nullable()
      t.integer('db_keep_count').nullable()
      t.boolean('db_verify').notNullable().defaultTo(true)
      t.boolean('files_enabled').notNullable().defaultTo(false)
      t.string('files_schedule', 120).nullable()
      longText(t, knex, 'files_target').nullable()
      longText(t, knex, 'target_secret').nullable()
      t.integer('files_keep_count').nullable()
      t.boolean('drill_enabled').notNullable().defaultTo(false)
      t.string('drill_schedule', 120).nullable()
      t.boolean('drill_checkdb').notNullable().defaultTo(false)
      t.string('notes', 1000).nullable()
      t.uuid('updated_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['environment_id'], { indexName: 'ux_nivaro_hub_backup_pol_env' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_data_runs'))) {
    await knex.schema.createTable('nivaro_hub_data_runs', (t) => {
      t.increments('id').primary()
      t.string('kind', 24).notNullable()
      t.integer('environment_id').notNullable()
      t.integer('source_environment_id').nullable()
      t.string('status', 16).notNullable().defaultTo('running')
      t.string('step', 40).nullable()
      t.string('started_via', 16).notNullable().defaultTo('person')
      longText(t, knex, 'steps').nullable()
      longText(t, knex, 'plan').nullable()
      t.string('plan_hash', 64).nullable()
      longText(t, knex, 'result').nullable()
      longText(t, knex, 'artifact').nullable()
      longText(t, knex, 'keep_secret').nullable()
      t.string('error', 1000).nullable()
      t.uuid('started_by').nullable()
      t.dateTime('started_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('finished_at').nullable()
      t.dateTime('heartbeat_at').nullable()
      t.dateTime('expires_at').nullable()
      t.index(['environment_id', 'kind'], 'ix_nivaro_hub_data_runs_env')
      t.index(['status'], 'ix_nivaro_hub_data_runs_status')
    })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: tables may hold live hub data.
}
