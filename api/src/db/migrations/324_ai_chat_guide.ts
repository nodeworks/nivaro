import type { Knex } from 'knex'

/**
 * Ask-AI data guide (Settings → AI Features).
 *
 *   ai_chat_guide  text, nullable — free text an admin writes to teach the
 *                  data assistant how THIS instance's data hangs together:
 *                  which collection bridges two others, what a human id looks
 *                  like, which fields people mean by their everyday names.
 *                  Appended to the chat's system prompt on every request; the
 *                  model has no other way to learn a deployment's domain.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'ai_chat_guide'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('ai_chat_guide').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'ai_chat_guide')) {
    await knex.schema.alterTable('nivaro_settings', (t) => t.dropColumn('ai_chat_guide'))
  }
}
