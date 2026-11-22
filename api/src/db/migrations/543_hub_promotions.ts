import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub phase 2: promotions. Created on every install, used only in hub mode. No foreign
 * keys; each step is skipped when it already exists. The unique index is declared in createTable
 * (portable on all five engines).
 *
 *  - nivaro_hub_components    what a placement deploys (api / frontend), in order
 *  - nivaro_hub_deploys       one promotion or rollback of an environment (history + plan);
 *                             heartbeat_at = renewed by the live runner with its lock, so a row
 *                             whose Redis lock vanished is still known to be running
 *  - nivaro_hub_environments.hub_managed   the hub deploys this environment
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_hub_components'))) {
    await knex.schema.createTable('nivaro_hub_components', (t) => {
      t.increments('id').primary()
      t.integer('placement_id').notNullable()
      t.integer('position').notNullable().defaultTo(0)
      t.string('name', 64).notNullable()
      t.string('kind', 16).notNullable()
      t.integer('driver_id').notNullable()
      t.string('source_branch', 200).notNullable().defaultTo('main')
      t.string('target_branch', 200).nullable()
      t.string('before_job', 100).nullable()
      t.string('deploy_job', 100).nullable()
      t.string('verify_url', 500).nullable()
      t.string('verify_field', 64).notNullable().defaultTo('version')
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['placement_id', 'position'], { indexName: 'ux_nivaro_hub_comp_pos' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_deploys'))) {
    await knex.schema.createTable('nivaro_hub_deploys', (t) => {
      t.increments('id').primary()
      t.integer('app_id').notNullable()
      t.integer('environment_id').notNullable()
      t.string('kind', 16).notNullable()
      t.string('version', 64).notNullable()
      t.string('from_version', 64).nullable()
      t.string('status', 16).notNullable().defaultTo('planned')
      t.string('step', 200).nullable()
      t.string('error', 1000).nullable()
      longText(t, knex, 'plan').nullable()
      t.integer('job_run_id').nullable()
      t.uuid('started_by').nullable()
      t.dateTime('started_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('finished_at').nullable()
      t.dateTime('heartbeat_at').nullable()
      t.index(['environment_id', 'id'], 'ix_nivaro_hub_deploys_env')
    })
  } else if (!(await knex.schema.hasColumn('nivaro_hub_deploys', 'heartbeat_at'))) {
    // A database that ran an earlier draft of this migration (phase 2 was never released).
    await knex.schema.alterTable('nivaro_hub_deploys', (t) => {
      t.dateTime('heartbeat_at').nullable()
    })
  }

  if (
    (await knex.schema.hasTable('nivaro_hub_environments')) &&
    !(await knex.schema.hasColumn('nivaro_hub_environments', 'hub_managed'))
  ) {
    await knex.schema.alterTable('nivaro_hub_environments', (t) => {
      t.boolean('hub_managed').notNullable().defaultTo(false)
    })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: tables may hold live hub data.
}
