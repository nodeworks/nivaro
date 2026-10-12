import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Migration 433 — Ask AI conversations (#1833 history, #1809 sharing, #1883
 * branches, #1851 posting to chat).
 *
 *  - nivaro_ai_conversations: one row per conversation, owned by the person
 *    who started it. `parent_id` + `branch_from` mark a branch (#1883): the
 *    conversation it was cut from and the message id of the question that was
 *    edited. No FK on parent_id — deleting the original keeps its branches.
 *  - nivaro_ai_conversation_messages: the turns, in id order. `author` is the
 *    person who asked (user turns) or whose permissions produced the answer
 *    (assistant turns) — the visibility check for shared threads keys on it.
 *    No FK on author: history survives a deleted account.
 *  - nivaro_ai_conversation_shares: who else may read and continue a
 *    conversation — a person (`user`) or a chat room (`room`, #1851; readers
 *    are whoever canSeeRoom admits). Per-row `pinned` so a recipient pins
 *    their copy without touching the owner's.
 *  - nivaro_settings.ai_conversation_retention_days: NULL = 180, 0 = keep
 *    forever. Pinned conversations are never pruned.
 *
 * Idempotent: every step checks before it creates.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_ai_conversations'))) {
    await knex.schema.createTable('nivaro_ai_conversations', (t) => {
      t.string('id', 36).primary()
      t.uuid('owner').notNullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
      t.string('title', 200).notNullable()
      t.boolean('pinned').notNullable().defaultTo(false)
      /** Branch source (#1883) — no FK, a deleted original keeps its branches. */
      t.string('parent_id', 36).nullable()
      /** Message id (in the parent) of the question that was edited. */
      t.bigInteger('branch_from').nullable()
      t.integer('message_count').notNullable().defaultTo(0)
      t.dateTime('created_at').notNullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').notNullable().defaultTo(utcNow(knex))
      t.index(['owner', 'updated_at'])
      t.index(['parent_id'])
    })
  }

  if (!(await knex.schema.hasTable('nivaro_ai_conversation_messages'))) {
    await knex.schema.createTable('nivaro_ai_conversation_messages', (t) => {
      t.bigIncrements('id').primary()
      t.string('conversation_id', 36)
        .notNullable()
        .references('id')
        .inTable('nivaro_ai_conversations')
        .onDelete('CASCADE')
      /** 'user' | 'assistant'. */
      t.string('role', 12).notNullable()
      /** Who asked / whose access answered. No FK — history outlives accounts. */
      t.uuid('author').nullable()
      t.text('content').notNullable()
      /** JSON: [{tool, input, summary, result_hash}] — what the answer read. */
      t.text('trace').nullable()
      /** JSON: the proposals the answer drafted (outcome read live). */
      t.text('proposals').nullable()
      /** JSON: request_id, truncated, stopped, playbooks_used, cached_at, rerun_of. */
      t.text('meta').nullable()
      t.dateTime('created_at').notNullable().defaultTo(utcNow(knex))
      t.index(['conversation_id', 'id'])
    })
  }

  if (!(await knex.schema.hasTable('nivaro_ai_conversation_shares'))) {
    await knex.schema.createTable('nivaro_ai_conversation_shares', (t) => {
      t.increments('id').primary()
      t.string('conversation_id', 36)
        .notNullable()
        .references('id')
        .inTable('nivaro_ai_conversations')
        .onDelete('CASCADE')
      /** A person the conversation is shared with … */
      t.uuid('user').nullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
      /** … or a chat room it was posted to (readers = whoever canSeeRoom admits). */
      t.string('room', 200).nullable()
      t.boolean('pinned').notNullable().defaultTo(false)
      t.uuid('shared_by').nullable()
      t.dateTime('created_at').notNullable().defaultTo(utcNow(knex))
      t.index(['conversation_id'])
      t.index(['user'])
      t.index(['room'])
    })
  }

  if (!(await knex.schema.hasColumn('nivaro_settings', 'ai_conversation_retention_days'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.integer('ai_conversation_retention_days').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'ai_conversation_retention_days')) {
    await knex.schema.alterTable('nivaro_settings', (t) =>
      t.dropColumn('ai_conversation_retention_days')
    )
  }
  await knex.schema.dropTableIfExists('nivaro_ai_conversation_shares')
  await knex.schema.dropTableIfExists('nivaro_ai_conversation_messages')
  await knex.schema.dropTableIfExists('nivaro_ai_conversations')
}
