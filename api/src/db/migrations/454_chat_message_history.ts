import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Migration 454 — keep the text of edited and deleted chat messages.
 *
 *  - nivaro_chat_message_history: one row per change to a message, holding the
 *    text and attachments as they were BEFORE the change. version 1 is the
 *    original send, then +1 per change. Read only by the admin message log.
 *  - nivaro_settings.chat_history_retention_days: NULL = 90, 0 = keep forever.
 *
 * Idempotent: every step checks before it creates.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_chat_message_history'))) {
    await knex.schema.createTable('nivaro_chat_message_history', (t) => {
      t.increments('id').primary()
      t.integer('message_id').notNullable()
      t.integer('version').notNullable()
      t.text('text').notNullable()
      /** JSON list of file ids, as stored on chat_messages.attachments. */
      t.text('attachments').nullable()
      t.dateTime('changed_at').notNullable().defaultTo(utcNow(knex))
      /** No FK — history outlives accounts. */
      t.uuid('changed_by').nullable()
      /** 'edit' | 'delete'. */
      t.string('reason', 12).notNullable()
      t.index(['message_id'])
      t.index(['changed_at'])
      t.unique(['message_id', 'version'])
    })
  }

  if (!(await knex.schema.hasColumn('nivaro_settings', 'chat_history_retention_days'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.integer('chat_history_retention_days').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'chat_history_retention_days')) {
    await knex.schema.alterTable('nivaro_settings', (t) => t.dropColumn('chat_history_retention_days'))
  }
  await knex.schema.dropTableIfExists('nivaro_chat_message_history')
}
