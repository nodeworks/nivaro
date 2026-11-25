import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { dialectOf, ensureIndex, indexExists, longText } from '../portable-ddl.js'

/**
 * Nivaro Hub config promotion (idea 30). Created on every install; no foreign keys; every step
 * guarded (a table / column / index that exists is left alone).
 *
 * HUB side (used only in hub mode):
 *  - nivaro_hub_config_promotions  one row per promotion of an app's configuration from one of its
 *    environments to another: group_keys / table_list (JSON lists), plan + plan_hash (the target's
 *    field diff, capped, and the hash an apply is bound to), run_key (the promotion's key at the
 *    target: idempotency, status, undo), heartbeat_at (the Hub's live run while it waits for an
 *    answer), result / undo_result (counts; never a secret, never a snapshot).
 *    Status: planned → applying → applied | failed | stale | interrupted (the answer was lost: the
 *    Hub polls the target by run_key); applied → undoing → undone | applied; planned → superseded.
 *
 * APP side (every app, Hub or not):
 *  - nivaro_hub_config_applied  one row per Hub promotion this app was asked to apply, written in
 *    its OWN short transaction before the apply starts: status applying (heartbeat_at while it runs)
 *    → deploying (rows committed, managed procedures being deployed) → applied | failed; undoing →
 *    undone. procs_plan / procs_done = the procedure work and its per-procedure progress (resumed by
 *    a resend of the run key).
 *  - nivaro_hub_config_writes  the commit marker: written INSIDE the apply's transaction with the
 *    rows it wrote (values before, hashes after) — it exists exactly when the write committed.
 *
 * Plus an index on nivaro_config_snapshots.trigger (the Changed-here baseline lookup).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_hub_config_applied'))) {
    await knex.schema.createTable('nivaro_hub_config_applied', (t) => {
      t.increments('id').primary()
      t.string('run_key', 64).notNullable()
      t.integer('promotion_id').nullable()
      t.string('source_label', 200).nullable()
      t.string('status', 16).notNullable().defaultTo('applying')
      t.dateTime('heartbeat_at').nullable()
      longText(t, knex, 'result').nullable()
      longText(t, knex, 'procs_plan').nullable()
      longText(t, knex, 'procs_done').nullable()
      longText(t, knex, 'undo_result').nullable()
      t.string('error', 1000).nullable()
      t.dateTime('applied_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('undone_at').nullable()
      t.unique(['run_key'], { indexName: 'ux_nivaro_hub_cfg_applied_run' })
    })
  }
  if (!(await knex.schema.hasTable('nivaro_hub_config_writes'))) {
    await knex.schema.createTable('nivaro_hub_config_writes', (t) => {
      t.increments('id').primary()
      t.string('run_key', 64).notNullable()
      longText(t, knex, 'undo_rows').nullable()
      t.boolean('undone').notNullable().defaultTo(false)
      t.dateTime('written_at').nullable().defaultTo(utcNow(knex))
      t.unique(['run_key'], { indexName: 'ux_nivaro_hub_cfg_writes_run' })
    })
  }
  if (!(await knex.schema.hasTable('nivaro_hub_config_promotions'))) {
    await knex.schema.createTable('nivaro_hub_config_promotions', (t) => {
      t.increments('id').primary()
      t.integer('app_id').notNullable()
      t.integer('source_environment_id').notNullable()
      t.integer('target_environment_id').notNullable()
      t.string('status', 16).notNullable().defaultTo('planned')
      longText(t, knex, 'group_keys').nullable()
      longText(t, knex, 'table_list').nullable()
      t.boolean('deletes').notNullable().defaultTo(false)
      t.boolean('allow_cascade').notNullable().defaultTo(false)
      t.boolean('production').notNullable().defaultTo(false)
      t.string('plan_hash', 64).nullable()
      longText(t, knex, 'plan').nullable()
      longText(t, knex, 'result').nullable()
      t.integer('pre_restore_id').nullable()
      t.string('undo_plan_hash', 64).nullable()
      longText(t, knex, 'undo_result').nullable()
      t.string('source_version', 40).nullable()
      t.string('target_version', 40).nullable()
      t.string('error', 1000).nullable()
      t.uuid('planned_by').nullable()
      t.uuid('applied_by').nullable()
      t.uuid('undone_by').nullable()
      t.dateTime('planned_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('started_at').nullable()
      t.dateTime('applied_at').nullable()
      t.dateTime('undone_at').nullable()
      t.index(['app_id', 'id'], 'ix_nivaro_hub_cfg_promo_app')
      t.index(['target_environment_id', 'status'], 'ix_nivaro_hub_cfg_promo_target')
    })
  }
  for (const [col, add] of [
    ['run_key', (t: Knex.AlterTableBuilder) => t.string('run_key', 64).nullable()],
    ['heartbeat_at', (t: Knex.AlterTableBuilder) => t.dateTime('heartbeat_at').nullable()]
  ] as const) {
    if (!(await knex.schema.hasColumn('nivaro_hub_config_promotions', col)))
      await knex.schema.alterTable('nivaro_hub_config_promotions', (t) => {
        add(t)
      })
  }
  if (await knex.schema.hasTable('nivaro_config_snapshots')) {
    const name = 'ix_nivaro_config_snapshots_trigger'
    if (dialectOf(knex) === 'mssql') {
      if (!(await indexExists(knex, 'nivaro_config_snapshots', name)))
        await knex.raw(`CREATE INDEX ${name} ON nivaro_config_snapshots ([trigger], id)`)
    } else
      await ensureIndex(knex, {
        name,
        table: 'nivaro_config_snapshots',
        columns: ['trigger', 'id']
      })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: the tables may hold the Hub's promotion history.
}
