import type { Knex } from 'knex'

// Full-page maintenance mode: how the freeze is presented to people who are
// not exempt ('banner' = the strip above the app, 'page' = the app is replaced
// by a maintenance screen until the freeze lifts) and, optionally, when it is
// expected to end — the page shows the time and a countdown. A scheduled
// window carries its own presentation and copies it onto the settings row
// when the sweep activates it.
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'maintenance_display'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.string('maintenance_display', 10).notNullable().defaultTo('banner') // banner | page
      t.datetime('maintenance_until').nullable()
    })
  }
  if (
    (await knex.schema.hasTable('nivaro_maintenance_windows')) &&
    !(await knex.schema.hasColumn('nivaro_maintenance_windows', 'display'))
  ) {
    await knex.schema.alterTable('nivaro_maintenance_windows', (t) => {
      t.string('display', 10).notNullable().defaultTo('banner')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'maintenance_display')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('maintenance_display')
      t.dropColumn('maintenance_until')
    })
  }
  if (
    (await knex.schema.hasTable('nivaro_maintenance_windows')) &&
    (await knex.schema.hasColumn('nivaro_maintenance_windows', 'display'))
  ) {
    await knex.schema.alterTable('nivaro_maintenance_windows', (t) => {
      t.dropColumn('display')
    })
  }
}
