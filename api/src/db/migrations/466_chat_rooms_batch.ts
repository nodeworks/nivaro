import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Chat rooms batch (#2459, #2474, #2483, #2485).
 *
 * NEW nivaro_chat_emoji    — custom emoji per workspace: shortcode + the stored
 *                            file (`file` has no FK so a deleted file only
 *                            makes the emoji fall back to its :shortcode: text).
 * NEW nivaro_chat_drafts   — unsent composer text per person per room, synced
 *                            across devices; pruned after 30 days.
 * nivaro_chat_channels     — mention_policy ('owner' default | 'members' |
 *                            'admins') = who may use @channel / @here;
 *                            archive_suggested_at / archive_kept_at = the idle
 *                            archive suggestion and the owner's "keep".
 * nivaro_settings          — chat_archive_idle_days (blank = 90).
 *
 * Guarded and additive. The code probes each column/table before use, so a
 * database behind this migration keeps chatting.
 */
async function addColumns(
  knex: Knex,
  table: string,
  cols: Array<[string, (t: Knex.AlterTableBuilder) => void]>
): Promise<void> {
  if (!(await knex.schema.hasTable(table))) return
  const missing: Array<(t: Knex.AlterTableBuilder) => void> = []
  for (const [name, add] of cols) {
    if (!(await knex.schema.hasColumn(table, name))) missing.push(add)
  }
  if (missing.length === 0) return
  await knex.schema.alterTable(table, (t) => {
    for (const add of missing) add(t)
  })
}

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_chat_emoji'))) {
    await knex.schema.createTable('nivaro_chat_emoji', (t) => {
      t.increments('id').primary()
      t.uuid('workspace').nullable()
      t.string('shortcode', 40).notNullable()
      t.uuid('file').notNullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').notNullable().defaultTo(utcNow(knex))
      t.unique(['workspace', 'shortcode'], { indexName: 'ux_chat_emoji_ws_code' })
    })
  }
  if (!(await knex.schema.hasTable('nivaro_chat_drafts'))) {
    await knex.schema.createTable('nivaro_chat_drafts', (t) => {
      t.increments('id').primary()
      t.uuid('user').notNullable()
      t.string('room', 200).notNullable()
      t.text('body').nullable()
      t.dateTime('updated_at').notNullable().defaultTo(utcNow(knex))
      t.unique(['user', 'room'], { indexName: 'ux_chat_drafts_user_room' })
      t.index(['updated_at'], 'ix_chat_drafts_updated')
    })
  }
  await addColumns(knex, 'nivaro_chat_channels', [
    ['mention_policy', (t) => t.string('mention_policy', 20).nullable()],
    ['archive_suggested_at', (t) => t.dateTime('archive_suggested_at').nullable()],
    ['archive_kept_at', (t) => t.dateTime('archive_kept_at').nullable()]
  ])
  await addColumns(knex, 'nivaro_settings', [
    ['chat_archive_idle_days', (t) => t.integer('chat_archive_idle_days').nullable()]
  ])
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_chat_drafts')
  await knex.schema.dropTableIfExists('nivaro_chat_emoji')
  const drop = async (table: string, cols: string[]) => {
    if (!(await knex.schema.hasTable(table))) return
    for (const c of cols) {
      if (await knex.schema.hasColumn(table, c)) {
        await knex.schema.alterTable(table, (t) => t.dropColumn(c))
      }
    }
  }
  await drop('nivaro_chat_channels', ['mention_policy', 'archive_suggested_at', 'archive_kept_at'])
  await drop('nivaro_settings', ['chat_archive_idle_days'])
}
