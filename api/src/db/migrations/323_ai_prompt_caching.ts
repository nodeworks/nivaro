import type { Knex } from 'knex'

/**
 * Prompt caching for the AI features (Settings → AI Features).
 *
 *   ai_prompt_caching  bit, default 1 — mark the stable prefix of every AI
 *                      call (system prompt, tool definitions, the conversation
 *                      so far) with `cache_control: {type: 'ephemeral'}` so a
 *                      tool loop or a chat re-reads it from the provider's
 *                      cache instead of re-billing it. Only Anthropic's API
 *                      and an Anthropic-native gateway honour the markers;
 *                      the OpenAI-compatible wire format has no field for
 *                      them, so the switch is inert there.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'ai_prompt_caching'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.boolean('ai_prompt_caching').notNullable().defaultTo(true)
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'ai_prompt_caching')) {
    await knex.schema.alterTable('nivaro_settings', (t) => t.dropColumn('ai_prompt_caching'))
  }
}
