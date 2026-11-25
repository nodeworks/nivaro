import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub change operations (Hub enhancements 26–28): deploy windows, pre-deploy checklists
 * and the change calendar's own entries (services/hub/releases/windows.ts, services/hub/changes/*).
 * Created on every install, used only in hub mode. No foreign keys; each table is skipped when it
 * already exists.
 *
 *  - nivaro_hub_deploy_windows    the times an app may be promoted (app_id null = every app that
 *                                 has none of its own). Weekly ranges as wall-clock times in
 *                                 `time_zone` (DST-correct), or one extra window (starts_at ..
 *                                 ends_at, UTC). env_scope all | production.
 *  - nivaro_hub_checklist_items   pre-deploy checklist items per app (environment_id null = every
 *                                 production environment of the app): text, required, who may
 *                                 tick (admin | owner | people + tick_people), which actions.
 *  - nivaro_hub_checklist_runs    one checklist for one start (a promotion, a move, a shared
 *                                 upgrade): the items as they were, the ticks (who, when, note),
 *                                 status open | used | void, and the run it was used for.
 *  - nivaro_hub_calendar_entries  entries the calendar holds itself: planned maintenance, notes,
 *                                 and entries other Hub features write (source + source_key, e.g.
 *                                 a certificate expiry).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_hub_deploy_windows'))) {
    await knex.schema.createTable('nivaro_hub_deploy_windows', (t) => {
      t.increments('id').primary()
      t.integer('app_id').nullable()
      t.string('name', 120).notNullable()
      t.string('env_scope', 16).notNullable().defaultTo('production')
      t.string('recurrence', 16).notNullable().defaultTo('weekly')
      longText(t, knex, 'ranges').nullable()
      t.dateTime('starts_at').nullable()
      t.dateTime('ends_at').nullable()
      t.string('time_zone', 64).nullable()
      t.boolean('enabled').notNullable().defaultTo(true)
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable()
      t.index(['app_id'], 'ix_nivaro_hub_dwindows_app')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_checklist_items'))) {
    await knex.schema.createTable('nivaro_hub_checklist_items', (t) => {
      t.increments('id').primary()
      t.integer('app_id').notNullable()
      t.integer('environment_id').nullable()
      t.string('text', 500).notNullable()
      t.string('help', 1000).nullable()
      t.boolean('required').notNullable().defaultTo(true)
      t.string('tick_by', 16).notNullable().defaultTo('owner')
      longText(t, knex, 'tick_people').nullable()
      t.string('actions', 64).notNullable().defaultTo('promote,move,upgrade')
      t.integer('position').notNullable().defaultTo(0)
      t.dateTime('archived_at').nullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable()
      t.index(['app_id'], 'ix_nivaro_hub_clitems_app')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_checklist_runs'))) {
    await knex.schema.createTable('nivaro_hub_checklist_runs', (t) => {
      t.increments('id').primary()
      t.string('target_kind', 16).notNullable()
      t.integer('target_id').notNullable()
      t.string('action', 32).notNullable() // extension_promote is 17 characters
      t.string('version', 64).nullable()
      t.string('status', 16).notNullable().defaultTo('open')
      longText(t, knex, 'items').nullable()
      longText(t, knex, 'ticks').nullable()
      t.string('source', 16).notNullable().defaultTo('person')
      t.integer('source_id').nullable()
      t.integer('source_step').nullable()
      t.string('run_kind', 16).nullable()
      t.integer('run_id').nullable()
      t.dateTime('claimed_at').nullable()
      // Compare-and-set on every tick (two people ticking at once never lose one).
      t.integer('rev').notNullable().defaultTo(0)
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable()
      t.dateTime('used_at').nullable()
      t.index(['target_kind', 'target_id', 'status'], 'ix_nivaro_hub_clruns_target')
      t.index(['run_kind', 'run_id'], 'ix_nivaro_hub_clruns_run')
      t.index(['source', 'source_id'], 'ix_nivaro_hub_clruns_source')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_calendar_entries'))) {
    await knex.schema.createTable('nivaro_hub_calendar_entries', (t) => {
      t.increments('id').primary()
      t.integer('app_id').nullable()
      t.integer('environment_id').nullable()
      t.string('kind', 16).notNullable().defaultTo('maintenance')
      t.string('source', 32).nullable()
      t.string('source_key', 120).nullable()
      t.string('title', 200).notNullable()
      t.string('description', 1000).nullable()
      t.dateTime('starts_at').notNullable()
      t.dateTime('ends_at').nullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable()
      t.index(['starts_at'], 'ix_nivaro_hub_calentries_start')
      t.index(['source', 'source_key'], 'ix_nivaro_hub_calentries_src')
    })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: tables may hold live hub data.
}
