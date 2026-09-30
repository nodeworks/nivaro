import type { Knex } from 'knex'

/**
 * nivaro_settings.chat_general — how the General room is dressed: name, topic,
 * icon/colour, announce-only, description, pinned links, welcome note and the
 * roles that join it automatically. General is the `global` room, not a
 * nivaro_chat_channels row, so its settings live on the instance singleton.
 * JSON text; NULL = the plain defaults. Written only by PATCH /chat/channels/0.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_settings'))) return
  if (await knex.schema.hasColumn('nivaro_settings', 'chat_general')) return
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.text('chat_general').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_settings'))) return
  if (await knex.schema.hasColumn('nivaro_settings', 'chat_general')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('chat_general')
    })
  }
}
