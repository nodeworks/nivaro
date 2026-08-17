import type { Knex } from 'knex'

/**
 * Chat feature batch — reactions, edit/delete, attachments, per-room notify
 * mode, group DMs, configurable AI bot.
 *
 * `chat_messages` is the LEGACY business table (EFP Directus era) — the ALTER
 * is hasTable/hasColumn-guarded so a fresh install without it migrates clean,
 * and columns are additive so the legacy app keeps writing untouched.
 *
 * `nivaro_chat_reactions.message_id` deliberately carries NO FK to
 * chat_messages — the table lives outside nivaro's schema ownership and a
 * constraint would couple nivaro migrations to legacy lifecycle.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('chat_messages')) {
    if (!(await knex.schema.hasColumn('chat_messages', 'edited_at'))) {
      await knex.schema.alterTable('chat_messages', (t) => {
        t.dateTime('edited_at').nullable()
        t.dateTime('deleted_at').nullable()
        t.text('attachments').nullable() // JSON string[] of nivaro_files ids
      })
    }
  }

  await knex.schema.createTable('nivaro_chat_reactions', (t) => {
    t.increments('id').primary()
    t.integer('message_id').notNullable().index()
    t.uuid('user').notNullable()
    t.string('emoji', 16).notNullable()
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now())
    t.unique(['message_id', 'user', 'emoji'])
  })

  await knex.schema.alterTable('nivaro_chat_memberships', (t) => {
    // null = 'all'. 'mentions' = only mention notifications; muted stays the
    // separate historic bit (mute wins over everything).
    t.string('notify_mode', 16).nullable()
  })

  await knex.schema.alterTable('nivaro_chat_channels', (t) => {
    // Group DMs are private channels rendered like conversations (member
    // names as the title) rather than #channels.
    t.boolean('is_direct').notNullable().defaultTo(false)
  })

  await knex.schema.alterTable('nivaro_settings', (t) => {
    // '@<name>' in any chat room routes the message to the AI assistant
    // (permission-checked, answers as the ASKING user). Null = bot disabled.
    t.string('chat_bot_name', 100).nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_chat_reactions')
  await knex.schema.alterTable('nivaro_chat_memberships', (t) => {
    t.dropColumn('notify_mode')
  })
  await knex.schema.alterTable('nivaro_chat_channels', (t) => {
    t.dropColumn('is_direct')
  })
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.dropColumn('chat_bot_name')
  })
  if (await knex.schema.hasColumn('chat_messages', 'edited_at')) {
    await knex.schema.alterTable('chat_messages', (t) => {
      t.dropColumn('edited_at')
      t.dropColumn('deleted_at')
      t.dropColumn('attachments')
    })
  }
}
