import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Migration 430 — chat polls (#2337) and chat message embeddings (#2354).
 *
 *  - nivaro_chat_polls: one row per poll message (message_id is the legacy
 *    chat_messages id, deliberately NO FK — that table predates us).
 *    `options` is a JSON array of labels, so a vote names an option by index.
 *  - nivaro_chat_poll_votes: one row per person per option.
 *  - nivaro_chat_embeddings: one vector per message for search-by-meaning.
 *    No FK either; rows of deleted messages are dropped by the indexer.
 *
 * Idempotent: every step checks before it creates.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_chat_polls'))) {
    await knex.schema.createTable('nivaro_chat_polls', (t) => {
      t.increments('id').primary()
      t.integer('message_id').notNullable().unique()
      t.string('room', 200).notNullable()
      t.string('question', 300).notNullable()
      t.text('options').notNullable()
      t.boolean('multiple').notNullable().defaultTo(false)
      t.boolean('anonymous').notNullable().defaultTo(false)
      t.dateTime('closes_at').nullable()
      t.dateTime('closed_at').nullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').notNullable().defaultTo(utcNow(knex))
      t.index(['room'], 'ix_chat_polls_room')
    })
  }
  if (!(await knex.schema.hasTable('nivaro_chat_poll_votes'))) {
    await knex.schema.createTable('nivaro_chat_poll_votes', (t) => {
      t.increments('id').primary()
      t.integer('poll_id').notNullable()
      t.integer('option_index').notNullable()
      t.uuid('user').notNullable()
      t.dateTime('created_at').notNullable().defaultTo(utcNow(knex))
      t.unique(['poll_id', 'user', 'option_index'], { indexName: 'ux_chat_poll_votes' })
      t.index(['poll_id'], 'ix_chat_poll_votes_poll')
    })
  }
  if (!(await knex.schema.hasTable('nivaro_chat_embeddings'))) {
    await knex.schema.createTable('nivaro_chat_embeddings', (t) => {
      t.integer('message_id').primary()
      t.string('room', 200).notNullable()
      t.text('embedding').notNullable()
      t.dateTime('created_at').notNullable().defaultTo(utcNow(knex))
      t.index(['room'], 'ix_chat_embeddings_room')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_chat_embeddings')
  await knex.schema.dropTableIfExists('nivaro_chat_poll_votes')
  await knex.schema.dropTableIfExists('nivaro_chat_polls')
}
