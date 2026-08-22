import type { Knex } from 'knex'

/**
 * Scheduled broadcasts (#94): scheduled_send_at = deliver later (null =
 * immediate, the historic behaviour); sent_at marks delivery done so the
 * scheduler can't double-send and history can tell "scheduled" from "sent".
 */
export async function up(knex: Knex): Promise<void> {
  // Repair: an early draft of migration 248 created nivaro_mail_log WITHOUT
  // the body column on databases that ran it first; the hasTable guard then
  // skipped the final shape and every logMail insert failed silently.
  if (!(await knex.schema.hasColumn('nivaro_mail_log', 'body'))) {
    await knex.schema.alterTable('nivaro_mail_log', (t) => {
      t.text('body').nullable()
    })
  }

  if (!(await knex.schema.hasColumn('nivaro_announcements', 'scheduled_send_at'))) {
    await knex.schema.alterTable('nivaro_announcements', (t) => {
      t.datetime('scheduled_send_at').nullable()
      t.datetime('sent_at').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_announcements', (t) => {
    t.dropColumn('scheduled_send_at')
    t.dropColumn('sent_at')
  })
}
