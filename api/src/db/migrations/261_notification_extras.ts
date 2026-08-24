import type { Knex } from 'knex'

// Notifications sprint: per-record mutes (#401) and record context on the
// mail log (#261 — records get a communications view).
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_notification_mutes'))) {
    await knex.schema.createTable('nivaro_notification_mutes', (t) => {
      t.increments('id')
      t.uuid('user').notNullable()
      t.string('collection', 255).notNullable()
      t.string('item', 255).notNullable()
      t.dateTime('created_at').defaultTo(knex.fn.now())
      t.unique(['user', 'collection', 'item'])
    })
  }
  for (const col of ['collection', 'item'] as const) {
    if (!(await knex.schema.hasColumn('nivaro_mail_log', col))) {
      await knex.schema.alterTable('nivaro_mail_log', (t) => {
        t.string(col, 255).nullable()
      })
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_notification_mutes')
  for (const col of ['collection', 'item'] as const) {
    if (await knex.schema.hasColumn('nivaro_mail_log', col)) {
      await knex.schema.alterTable('nivaro_mail_log', (t) => t.dropColumn(col))
    }
  }
}
