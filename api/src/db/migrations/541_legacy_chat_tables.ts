import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { dialectOf, ensureIndex, indexExists, longText } from '../portable-ddl.js'

/**
 * Two tables the API reads and writes that no migration ever created, so a fresh install (every
 * engine, SQL Server included) answered 500 on them. Existing environments already have them;
 * each step is skipped when its table exists (its columns and indexes are then left as they are).
 *
 * 1. `chat_messages` — the LEGACY (Directus-era) chat message table. Migrations 213, 367, 370,
 *    442 and 478 only ALTER it when it exists, so it is created here with every column they add
 *    (and the chat code reads today): a fresh install then runs the same chat code as an old one,
 *    and those guarded ALTERs stay no-ops. Columns:
 *      id, room, message, sender (user id; NULL for a platform line), sender_name, date_created
 *      213  edited_at, deleted_at, attachments (JSON file ids)
 *      367  masquerade_admin
 *      370  parent_id, quote_id, urgent, is_system, no_preview, client_id, mentions, time_refs
 *           + ix_chat_messages_parent_id (thread replies; filtered where the engine can)
 *      442  ops_only
 *      478  via_app
 *    plus ix_chat_messages_room_id (room timelines, unread counts). No foreign keys, like every
 *    table that points at it (reactions, pins, saved, polls carry message ids without one).
 *
 * 2. `nivaro_field_translations` — per-locale values of translatable fields
 *    (routes/field-translations.ts): one row per (collection, item_id, field, locale).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('chat_messages'))) {
    await knex.schema.createTable('chat_messages', (t) => {
      t.increments('id').primary()
      t.string('room', 200).notNullable()
      longText(t, knex, 'message').nullable()
      t.uuid('sender').nullable()
      t.string('sender_name', 255).nullable()
      t.dateTime('date_created').nullable().defaultTo(utcNow(knex))
      t.dateTime('edited_at').nullable()
      t.dateTime('deleted_at').nullable()
      t.text('attachments').nullable()
      t.uuid('masquerade_admin').nullable()
      t.integer('parent_id').nullable()
      t.integer('quote_id').nullable()
      t.boolean('urgent').nullable()
      t.boolean('is_system').nullable()
      t.boolean('no_preview').nullable()
      t.string('client_id', 64).nullable()
      t.text('mentions').nullable()
      t.text('time_refs').nullable()
      t.boolean('ops_only').nullable()
      t.string('via_app', 80).nullable()
    })
    // Indexes only on a table made here: an existing environment keeps the indexes it has.
    await chatIndexes(knex)
  }

  if (!(await knex.schema.hasTable('nivaro_field_translations'))) {
    await knex.schema.createTable('nivaro_field_translations', (t) => {
      t.increments('id').primary()
      t.string('collection', 64).notNullable()
      t.string('item_id', 64).notNullable()
      t.string('field', 64).notNullable()
      t.string('locale', 16).notNullable()
      longText(t, knex, 'value').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['collection', 'item_id', 'field', 'locale'], {
        indexName: 'ux_field_translations_key'
      })
    })
  }
}

async function chatIndexes(knex: Knex): Promise<void> {
  if (dialectOf(knex) === 'mssql') {
    if (!(await indexExists(knex, 'chat_messages', 'ix_chat_messages_room_id')))
      await knex.raw('CREATE INDEX ix_chat_messages_room_id ON chat_messages (room, id)')
    if (!(await indexExists(knex, 'chat_messages', 'ix_chat_messages_parent_id')))
      await knex.raw(
        'CREATE INDEX ix_chat_messages_parent_id ON chat_messages (parent_id) WHERE parent_id IS NOT NULL'
      )
    return
  }
  await ensureIndex(knex, {
    name: 'ix_chat_messages_room_id',
    table: 'chat_messages',
    columns: ['room', 'id']
  })
  await ensureIndex(knex, {
    name: 'ix_chat_messages_parent_id',
    table: 'chat_messages',
    columns: ['parent_id'],
    where: 'parent_id IS NOT NULL'
  })
}

export async function down(): Promise<void> {
  // Nothing to undo: both tables may predate this migration and hold live rows.
}
