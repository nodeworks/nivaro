import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub config promotion (idea 30): one row per promotion of an app's configuration from one
 * of its environments to another. Created on every install, used only in hub mode; no foreign
 * keys; skipped when it already exists.
 *
 *  - group_keys / table_list  what was asked for (JSON lists)
 *  - plan / plan_hash     the target app's plan (field diff capped, counts, what it keeps) and the
 *                         hash an apply is bound to
 *  - pre_restore_id       the restore point the TARGET app stored inside the apply's transaction
 *                         (its own nivaro_config_snapshots id; informational — undo uses the
 *                         app's nivaro_hub_config_applied record)
 *  - run_key              the promotion's key at the target app (idempotency; nivaro_hub_config_applied)
 *  - result / undo_result counts the app answered; never a secret, never a snapshot
 *
 * nivaro_hub_config_applied (every app): one row per Hub promotion this app applied — the rows it
 * wrote with their values before and hashes after (undo), procedure results; status applied /
 * undone. Written inside the apply's own transaction.
 *
 * Status: planned → applying → applied | failed | stale | interrupted (the answer was lost: the
 * Hub asks the app by run_key); applied → undoing → undone | applied (undo refused);
 * planned → superseded (a newer plan for the same target).
 */
export async function up(knex: Knex): Promise<void> {
  // The APP side (every app, Hub or not): what this app applied for a Hub promotion, so a lost
  // answer can be told and an undo puts back exactly those rows.
  if (!(await knex.schema.hasTable('nivaro_hub_config_applied'))) {
    await knex.schema.createTable('nivaro_hub_config_applied', (t) => {
      t.increments('id').primary()
      t.string('run_key', 64).notNullable()
      t.integer('promotion_id').nullable()
      t.string('source_label', 200).nullable()
      t.string('status', 16).notNullable().defaultTo('applied')
      longText(t, knex, 'result').nullable()
      longText(t, knex, 'undo').nullable()
      longText(t, knex, 'undo_result').nullable()
      t.dateTime('applied_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('undone_at').nullable()
      t.unique(['run_key'], { indexName: 'ux_nivaro_hub_cfg_applied_run' })
    })
  }
  if (await knex.schema.hasTable('nivaro_hub_config_promotions')) return
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
    t.string('run_key', 64).nullable()
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

export async function down(): Promise<void> {
  // Nothing to undo: the table may hold the Hub's promotion history.
}
