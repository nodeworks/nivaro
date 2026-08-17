import type { Knex } from 'knex'

/**
 * Chat pins + bot reminders.
 *
 * Pins: any room member can pin a message; the room renders a pinned strip.
 * message_id carries no FK (chat_messages is the legacy table — same posture
 * as nivaro_chat_reactions).
 *
 * Reminders: "@<bot> remind me Friday about X" — the bot's set_reminder tool
 * writes a row; a 5-minute cron delivers due ones via notifyUser (in-app +
 * web push) and marks them sent.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_chat_pins', (t) => {
    t.increments('id').primary()
    t.string('room', 200).notNullable().index()
    t.integer('message_id').notNullable()
    t.uuid('pinned_by').notNullable()
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now())
    t.unique(['room', 'message_id'])
  })

  await knex.schema.createTable('nivaro_reminders', (t) => {
    t.increments('id').primary()
    t.uuid('user').notNullable().index()
    t.string('note', 500).notNullable()
    t.string('room', 200).nullable()
    t.dateTime('remind_at').notNullable()
    t.boolean('sent').notNullable().defaultTo(false)
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now())
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_chat_pins')
  await knex.schema.dropTableIfExists('nivaro_reminders')
}
