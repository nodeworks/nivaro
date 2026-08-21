import type { Knex } from 'knex'

/** Notification snooze: a snoozed row hides from the inbox until its wake
 *  time passes, then reappears UNREAD. */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_notifications', 'snoozed_until'))) {
    await knex.schema.alterTable('nivaro_notifications', (t) => {
      t.dateTime('snoozed_until').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_notifications', 'snoozed_until')) {
    await knex.schema.alterTable('nivaro_notifications', (t) => {
      t.dropColumn('snoozed_until')
    })
  }
}
