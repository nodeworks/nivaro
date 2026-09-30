import type { Knex } from 'knex'

/**
 * nivaro_chat_channels.icon + color — how a channel looks in the room list and
 * header. `icon` is one of a fixed set of names the client knows how to draw
 * (CHANNEL_ICONS in services/chat.ts); `color` is a #rrggbb from the fixed
 * palette. NULL = the plain "#" tile, as before.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_chat_channels'))) return
  const hasIcon = await knex.schema.hasColumn('nivaro_chat_channels', 'icon')
  const hasColor = await knex.schema.hasColumn('nivaro_chat_channels', 'color')
  if (hasIcon && hasColor) return
  await knex.schema.alterTable('nivaro_chat_channels', (t) => {
    if (!hasIcon) t.string('icon', 40).nullable()
    if (!hasColor) t.string('color', 20).nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_chat_channels'))) return
  for (const c of ['icon', 'color']) {
    if (await knex.schema.hasColumn('nivaro_chat_channels', c)) {
      await knex.schema.alterTable('nivaro_chat_channels', (t) => {
        t.dropColumn(c)
      })
    }
  }
}
