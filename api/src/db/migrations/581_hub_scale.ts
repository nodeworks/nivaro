import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub scaling (manual + automatic) of Docker stacks and shared deployments. Created on
 * every install, used only in hub mode. No foreign keys; each table / column is skipped when it
 * already exists.
 *
 *  - nivaro_hub_scale_roles   one row per stack (an environment's dedicated stack, or a shared
 *                             deployment) and role: the replicas and limits the Hub keeps on top
 *                             of the size template (the renderers lay them over it), the "pin
 *                             manual" switch, the autoscaling rule (JSON) and its state (JSON:
 *                             counters, last change, times the rule wanted more than its max).
 *  - nivaro_hub_scale_runs    one row per scaling change (manual, automatic or by schedule) with
 *                             its reason and the figures that caused it, the shape before and
 *                             after, its steps (a realtime scale-in drains one replica at a time)
 *                             and heartbeat; `skipped` rows are automatic decisions that could
 *                             not run (at the rule's max, past the connection limit, paused).
 *  - nivaro_hub_db_servers.max_connections   the database server's connection limit, which the
 *                             scale plan checks every process's pools against (null = unknown).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_hub_scale_roles'))) {
    await knex.schema.createTable('nivaro_hub_scale_roles', (t) => {
      t.increments('id').primary()
      t.string('target_kind', 16).notNullable()
      t.integer('target_id').notNullable()
      t.string('role', 16).notNullable()
      t.integer('replicas').nullable()
      t.float('cpus').nullable()
      t.integer('memory_mb').nullable()
      t.boolean('pinned').notNullable().defaultTo(false)
      longText(t, knex, 'auto').nullable()
      longText(t, knex, 'state').nullable()
      t.uuid('updated_by').nullable()
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['target_kind', 'target_id', 'role'], { indexName: 'ux_nivaro_hub_scale_roles' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_scale_runs'))) {
    await knex.schema.createTable('nivaro_hub_scale_runs', (t) => {
      t.increments('id').primary()
      t.string('target_kind', 16).notNullable()
      t.integer('target_id').notNullable()
      t.string('stack', 64).nullable()
      t.string('source', 16).notNullable().defaultTo('manual')
      t.string('status', 16).notNullable().defaultTo('running')
      t.string('reason', 500).nullable()
      longText(t, knex, 'figures').nullable()
      longText(t, knex, 'from_shape').nullable()
      longText(t, knex, 'to_shape').nullable()
      longText(t, knex, 'steps').nullable()
      t.integer('step_index').notNullable().defaultTo(0)
      t.string('spec_hash', 64).nullable()
      t.string('plan_hash', 64).nullable()
      t.string('error_code', 64).nullable()
      t.string('error', 1000).nullable()
      t.uuid('started_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('finished_at').nullable()
      t.dateTime('heartbeat_at').nullable()
      t.index(['target_kind', 'target_id', 'id'], 'ix_nivaro_hub_scale_runs_target')
      t.index(['status'], 'ix_nivaro_hub_scale_runs_status')
    })
  }

  if (
    (await knex.schema.hasTable('nivaro_hub_db_servers')) &&
    !(await knex.schema.hasColumn('nivaro_hub_db_servers', 'max_connections'))
  ) {
    await knex.schema.alterTable('nivaro_hub_db_servers', (t) => {
      t.integer('max_connections').nullable()
    })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: tables may hold live hub data.
}
