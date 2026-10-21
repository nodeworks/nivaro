import type { Knex } from 'knex'

/**
 * Layout history, part two (#2610, #2590).
 *
 * 1. nivaro_layout_versions.name — a version an admin named ("go-live
 *    baseline"). Pruning keeps the newest 30 UNNAMED versions per layout and
 *    every named one, so a baseline outlives any amount of later editing.
 *
 * 2. nivaro_layout_schedules — layout changes made in the editor and set to
 *    apply later: the unsaved ops, the rev they were made against and when to
 *    run. The `layout-schedules` cron applies due rows through the same ops
 *    service a Save uses (one version, one activity row). No FKs: a schedule
 *    of a deleted layout simply fails, and created_by/updated_by name people
 *    without tying their deletion to these rows.
 *
 * Guarded and additive: every step checks first; down() drops only what this
 * migration added.
 */
export async function up(knex: Knex): Promise<void> {
  if (
    (await knex.schema.hasTable('nivaro_layout_versions')) &&
    !(await knex.schema.hasColumn('nivaro_layout_versions', 'name'))
  ) {
    await knex.schema.alterTable('nivaro_layout_versions', (t) => {
      t.string('name', 120).nullable()
    })
  }

  if (!(await knex.schema.hasTable('nivaro_layout_schedules'))) {
    await knex.schema.createTable('nivaro_layout_schedules', (t) => {
      t.increments('id')
      t.integer('layout_id').notNullable()
      t.string('collection', 255).notNullable()
      t.text('ops').notNullable() // JSON LayoutOp[]
      t.string('base_rev', 128).notNullable()
      t.string('note', 255).nullable()
      t.dateTime('run_at').notNullable()
      // pending | running | applied | failed | cancelled
      t.string('status', 20).notNullable().defaultTo('pending')
      t.text('error').nullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').notNullable()
      t.uuid('updated_by').nullable()
      t.dateTime('updated_at').nullable()
      t.dateTime('applied_at').nullable()
      t.index(['status', 'run_at'], 'ix_layout_schedules_status_run')
      t.index(['collection', 'status'], 'ix_layout_schedules_collection')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_layout_schedules'))
    await knex.schema.dropTable('nivaro_layout_schedules')
  if (
    (await knex.schema.hasTable('nivaro_layout_versions')) &&
    (await knex.schema.hasColumn('nivaro_layout_versions', 'name'))
  ) {
    await knex.schema.alterTable('nivaro_layout_versions', (t) => {
      t.dropColumn('name')
    })
  }
}
