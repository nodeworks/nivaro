import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub phase 6: the runs of shared deployments (upgrade, rollback, an observed version
 * change) and the moves of an environment between a dedicated stack and a shared deployment.
 * Created on every install, used only in hub mode. No foreign keys; each table is skipped when
 * it already exists.
 *
 *  - nivaro_hub_shared_deploys  one row per shared deploy run (kind upgrade|rollback|observed)
 *  - nivaro_hub_moves           one row per move (kind to_shared|to_dedicated|between_shared,
 *                               routing automatic|manual); `placed_at` marks the environment as
 *                               placed on the target before release (preflight B2) and
 *                               `prior_status` keeps the environment's status while a move holds
 *                               it in maintenance (preflight B1)
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_hub_shared_deploys'))) {
    await knex.schema.createTable('nivaro_hub_shared_deploys', (t) => {
      t.increments('id').primary()
      t.integer('shared_deployment_id').notNullable()
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
      t.index(['shared_deployment_id'], 'ix_nivaro_hub_shdep_shared')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_moves'))) {
    await knex.schema.createTable('nivaro_hub_moves', (t) => {
      t.increments('id').primary()
      t.integer('app_id').notNullable()
      t.integer('environment_id').notNullable()
      t.integer('from_placement_id').notNullable()
      t.integer('to_placement_id').notNullable()
      t.string('kind', 16).notNullable()
      t.string('routing', 16).notNullable()
      t.string('status', 16).notNullable().defaultTo('planned')
      t.string('step', 32).nullable()
      longText(t, knex, 'steps').notNullable()
      longText(t, knex, 'plan').nullable()
      t.string('plan_hash', 64).nullable()
      longText(t, knex, 'files').nullable()
      longText(t, knex, 'checklist').nullable()
      t.string('error', 1000).nullable()
      t.dateTime('placed_at').nullable()
      t.string('prior_status', 16).nullable()
      t.integer('job_run_id').nullable()
      t.uuid('started_by').nullable()
      t.dateTime('started_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('finished_at').nullable()
      t.dateTime('heartbeat_at').nullable()
      t.index(['environment_id'], 'ix_nivaro_hub_moves_env')
      // Open moves into / out of a placement (the tenants listing, preflight B2).
      t.index(['to_placement_id', 'status'], 'ix_nivaro_hub_moves_to')
      t.index(['from_placement_id', 'status'], 'ix_nivaro_hub_moves_from')
    })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: tables may hold live hub data.
}
