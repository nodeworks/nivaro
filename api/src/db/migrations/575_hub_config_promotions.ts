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
 *                         (its own nivaro_config_snapshots id): undo restores it
 *  - result / undo_result counts the app answered; never a secret, never a snapshot
 *
 * Status: planned → applying → applied | failed; applied → undoing → undone | applied (undo
 * failed); planned → superseded (a newer plan for the same target) | expired. A row left
 * `applying` / `undoing` by a stopped process reads as `interrupted`.
 */
export async function up(knex: Knex): Promise<void> {
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
