import type { Knex } from 'knex'

/**
 * AI call details (#2471, #2765, #2737).
 *
 * `nivaro_ai_calls.meta` — text JSON about how one model call was made:
 * `routing` (start-cheap tier, the feature's main model, why it moved up),
 * `tool_payload` (per tool: readable vs compact token estimates of the tool
 * results this call carried) and `reused` (tool results served from the
 * conversation's store instead of a new query). The AI quality page sums it
 * for the routing savings figure and the tool payload table.
 *
 * Guarded and additive: nullable, no default, added only when missing. The
 * call log writes it only once it exists (aiCallMetaSupported).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_ai_calls'))) return
  if (await knex.schema.hasColumn('nivaro_ai_calls', 'meta')) return
  await knex.schema.alterTable('nivaro_ai_calls', (t) => {
    t.text('meta').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_ai_calls', 'meta'))) return
  await knex.schema.alterTable('nivaro_ai_calls', (t) => {
    t.dropColumn('meta')
  })
}
