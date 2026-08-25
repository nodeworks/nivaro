import type { Knex } from 'knex'

// Maintenance lifecycle (#214/#218/#303/#365): scheduled windows that flip
// maintenance mode on/off, pre-announce via the banner, auto-send the
// all-clear after a passing smoke check, and pause the alert engines while
// active.
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_maintenance_windows'))) {
    await knex.schema.createTable('nivaro_maintenance_windows', (t) => {
      t.increments('id')
      t.string('title', 300).notNullable()
      t.text('message').nullable()
      t.datetime('starts_at').notNullable()
      t.datetime('ends_at').notNullable()
      t.string('status', 20).notNullable().defaultTo('scheduled') // scheduled|active|completed|cancelled
      t.boolean('send_all_clear').notNullable().defaultTo(true)
      t.uuid('created_by').nullable()
      t.datetime('created_at').notNullable()
      t.datetime('activated_at').nullable()
      t.datetime('completed_at').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_maintenance_windows')) {
    await knex.schema.dropTable('nivaro_maintenance_windows')
  }
}
