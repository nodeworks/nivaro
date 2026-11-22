import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub phase 3: app creation runs, plus the creation settings an app carries. Created on
 * every install, used only in hub mode. No foreign keys; every step is skipped when it exists.
 *
 *  - nivaro_hub_creations                       one creation run per environment
 *  - nivaro_hub_apps.target_id / deploy_project / oidc / oidc_secret
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_hub_creations'))) {
    await knex.schema.createTable('nivaro_hub_creations', (t) => {
      t.increments('id').primary()
      t.integer('app_id').notNullable()
      t.integer('environment_id').notNullable()
      t.string('status', 16).notNullable().defaultTo('queued')
      t.string('step', 32).nullable()
      t.string('waiting_for', 16).nullable()
      longText(t, knex, 'steps').notNullable()
      longText(t, knex, 'made').nullable()
      t.string('error', 1000).nullable()
      t.string('version', 64).notNullable()
      longText(t, knex, 'first_admin').notNullable()
      t.integer('job_run_id').nullable()
      t.uuid('started_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('finished_at').nullable()
      t.unique(['environment_id'], { indexName: 'ux_nivaro_hub_creation_env' })
    })
  }

  if (await knex.schema.hasTable('nivaro_hub_apps')) {
    if (!(await knex.schema.hasColumn('nivaro_hub_apps', 'target_id'))) {
      await knex.schema.alterTable('nivaro_hub_apps', (t) => t.integer('target_id').nullable())
    }
    if (!(await knex.schema.hasColumn('nivaro_hub_apps', 'deploy_project'))) {
      await knex.schema.alterTable('nivaro_hub_apps', (t) =>
        t.string('deploy_project', 300).nullable()
      )
    }
    if (!(await knex.schema.hasColumn('nivaro_hub_apps', 'oidc'))) {
      await knex.schema.alterTable('nivaro_hub_apps', (t) => longText(t, knex, 'oidc').nullable())
    }
    if (!(await knex.schema.hasColumn('nivaro_hub_apps', 'oidc_secret'))) {
      await knex.schema.alterTable('nivaro_hub_apps', (t) =>
        longText(t, knex, 'oidc_secret').nullable()
      )
    }
  }
}

// Additive only: a rollback keeps the tables and columns (and what is in them) in place.
export async function down(): Promise<void> {}
