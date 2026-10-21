import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Scheduled huddles (#2860): a huddle planned for a time in a channel, record
 * room or direct conversation, with invitees. The room gets a card message
 * when it is made; invitees get a reminder five minutes before and are rung
 * at the start (services/huddle-schedule.ts, cron `huddle-schedules`).
 *
 *   nivaro_chat_huddle_schedules
 *     id            int identity
 *     room          varchar(200)   the chat room key
 *     title         varchar(200)
 *     starts_at     datetime (UTC)
 *     duration_min  int            5–480
 *     created_by    uuid FK nivaro_users (NO ACTION)
 *     invitees      text JSON      user ids who were asked (each could see the room when invited)
 *     message_id    bigint NULL    the card message posted in the room
 *     status        varchar(16)    scheduled | cancelled | done
 *     reminded_at   datetime NULL  the 5-minute reminder went out (the claim)
 *     rang_at       datetime NULL  invitees were rung at the start (the claim)
 *     created_at    datetime
 *
 * Guarded and additive. RUNTIME data — never copied between instances.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_chat_huddle_schedules')) return
  await knex.schema.createTable('nivaro_chat_huddle_schedules', (t) => {
    t.increments('id').primary()
    t.string('room', 200).notNullable()
    t.string('title', 200).notNullable()
    t.dateTime('starts_at').notNullable()
    t.integer('duration_min').notNullable().defaultTo(30)
    t.uuid('created_by')
      .notNullable()
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
    t.text('invitees').nullable()
    t.bigInteger('message_id').nullable()
    t.string('status', 16).notNullable().defaultTo('scheduled')
    t.dateTime('reminded_at').nullable()
    t.dateTime('rang_at').nullable()
    t.dateTime('created_at').notNullable().defaultTo(utcNow(knex))
    t.index(['status', 'starts_at'], 'ix_huddle_sched_due')
    t.index(['room', 'starts_at'], 'ix_huddle_sched_room')
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_chat_huddle_schedules'))) return
  await knex.schema.dropTable('nivaro_chat_huddle_schedules')
}
