import type { Knex } from 'knex'

/**
 * Monitor subscribers — additional recipients for a monitor's ok→failing
 * notification. The creator is always notified; subscribers are opt-in extras
 * managed from the Monitors page.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_monitor_subscribers'))) {
    await knex.schema.createTable('nivaro_monitor_subscribers', (t) => {
      t.increments('id')
      t.integer('monitor_id')
        .notNullable()
        .references('id')
        .inTable('nivaro_monitors')
        .onDelete('CASCADE')
      t.uuid('user').notNullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
      t.dateTime('created_at').nullable()
      t.unique(['monitor_id', 'user'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_monitor_subscribers')
}
