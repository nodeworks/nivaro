import type { Knex } from 'knex'

/**
 * chat_messages.masquerade_admin — the admin who was masquerading when the
 * message was sent (NULL = the sender themselves). chat_messages is the
 * LEGACY business table, so the ALTER is hasTable/hasColumn-guarded like
 * migration 213. No FK: a deleted admin must never block the thread.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('chat_messages'))) return
  if (await knex.schema.hasColumn('chat_messages', 'masquerade_admin')) return
  await knex.schema.alterTable('chat_messages', (t) => {
    t.uuid('masquerade_admin').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('chat_messages'))) return
  if (!(await knex.schema.hasColumn('chat_messages', 'masquerade_admin'))) return
  await knex.schema.alterTable('chat_messages', (t) => {
    t.dropColumn('masquerade_admin')
  })
}
