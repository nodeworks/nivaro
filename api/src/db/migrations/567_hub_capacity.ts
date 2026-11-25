import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub capacity (ideas 9, 13, 15, 16): what the Hub measures of its apps, the limits it
 * sets for apps on a shared deployment, and the rebalance runs it plans. Created on every install,
 * used only in hub mode. No foreign keys; each table is skipped when it already exists.
 *
 *  - nivaro_hub_capacity_samples  one row per shared deployment (scope `shared`, its totals) and
 *                                 one per environment (scope `environment`; shared_deployment_id
 *                                 set when it runs there) per sample, every 15 minutes, kept 31
 *                                 days. Aggregate figures only: counts, timings, bytes.
 *  - nivaro_hub_app_limits        one row per environment: requests per minute, background jobs
 *                                 at once and file storage (MB) on a shared deployment; null =
 *                                 no limit. Listed with the app in the tenants answer.
 *  - nivaro_hub_rebalances        one row per rebalance: the planned moves (each a normal move),
 *                                 the quiet window they may start in, which move runs now.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_hub_capacity_samples'))) {
    await knex.schema.createTable('nivaro_hub_capacity_samples', (t) => {
      t.increments('id').primary()
      t.dateTime('sampled_at').notNullable()
      t.string('scope', 16).notNullable()
      t.integer('shared_deployment_id').nullable()
      t.integer('environment_id').nullable()
      t.string('tenant_id', 64).nullable()
      t.float('cpu_pct').nullable()
      t.float('memory_mb').nullable()
      t.float('requests_per_min').nullable()
      t.float('busy_ms_per_min').nullable()
      t.float('errors_per_min').nullable()
      t.integer('db_in_use').nullable()
      t.integer('db_waiting').nullable()
      t.integer('db_pool_max').nullable()
      t.integer('jobs_running').nullable()
      t.integer('jobs_waiting').nullable()
      t.bigInteger('storage_bytes').nullable()
      t.integer('processes').nullable()
      t.string('error', 64).nullable()
      t.index(['environment_id', 'sampled_at'], 'ix_nivaro_hub_capsamp_env')
      t.index(['shared_deployment_id', 'sampled_at'], 'ix_nivaro_hub_capsamp_shared')
      t.index(['sampled_at'], 'ix_nivaro_hub_capsamp_at')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_app_limits'))) {
    await knex.schema.createTable('nivaro_hub_app_limits', (t) => {
      t.increments('id').primary()
      t.integer('environment_id').notNullable()
      t.integer('requests_per_minute').nullable()
      t.integer('jobs').nullable()
      t.integer('storage_mb').nullable()
      t.uuid('updated_by').nullable()
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['environment_id'], { indexName: 'ux_nivaro_hub_app_limits_env' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_rebalances'))) {
    await knex.schema.createTable('nivaro_hub_rebalances', (t) => {
      t.increments('id').primary()
      t.string('status', 16).notNullable().defaultTo('running')
      longText(t, knex, 'shared_ids').notNullable()
      longText(t, knex, 'moves').notNullable()
      t.string('window_start', 5).notNullable()
      t.string('window_end', 5).notNullable()
      t.string('window_tz', 64).notNullable()
      t.integer('current_index').notNullable().defaultTo(0)
      t.integer('current_move_id').nullable()
      t.string('note', 500).nullable()
      t.string('error', 1000).nullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('started_at').nullable()
      t.dateTime('finished_at').nullable()
      t.dateTime('heartbeat_at').nullable()
      t.index(['status'], 'ix_nivaro_hub_rebal_status')
    })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: tables may hold live hub data.
}
