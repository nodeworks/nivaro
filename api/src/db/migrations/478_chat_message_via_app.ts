import type { Knex } from 'knex'

/**
 * Chat tools in MCP (#2492): a message an AI assistant posted for a person
 * names the connected app that wrote it.
 *
 *   chat_messages.via_app  nvarchar(80) NULL
 *     the OAuth app's registered name, else the API key's name; NULL = the
 *     person wrote it themselves
 *
 * Guarded and additive (`chat_messages` is a legacy table). Until it runs the
 * send path puts the app's name in sender_name instead (services/chat-send.ts).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('chat_messages'))) return
  if (await knex.schema.hasColumn('chat_messages', 'via_app')) return
  await knex.schema.alterTable('chat_messages', (t) => {
    t.string('via_app', 80).nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('chat_messages'))) return
  if (!(await knex.schema.hasColumn('chat_messages', 'via_app'))) return
  await knex.schema.alterTable('chat_messages', (t) => {
    t.dropColumn('via_app')
  })
}
