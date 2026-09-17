import type { Knex } from 'knex'

/**
 * A separate model for Ask AI (Settings → AI Features).
 *
 *   ai_gateway_chat_model  nullable — the gateway model id the data-assistant
 *                          chat (and the chat bot) run on. NULL = the general
 *                          ai_gateway_model. The chat is the one feature that
 *                          reasons across several tool calls, where a small
 *                          model gives confident wrong answers; every other AI
 *                          call (generate, summarize, validate, briefs) is a
 *                          single short prompt a cheap model handles fine.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'ai_gateway_chat_model'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.string('ai_gateway_chat_model', 100).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'ai_gateway_chat_model')) {
    await knex.schema.alterTable('nivaro_settings', (t) => t.dropColumn('ai_gateway_chat_model'))
  }
}
