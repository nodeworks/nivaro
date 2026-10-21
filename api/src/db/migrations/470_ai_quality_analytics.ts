import type { Knex } from 'knex'

/**
 * AI quality analytics (#2473, #2731, #2732, #2764).
 *
 *  - `nivaro_ai_calls.prompt_parts` — text JSON, the tokens each part of the
 *    request carried (system rules, tool definitions, data guide, glossary,
 *    playbooks, history, attachments …) with the cached share of each.
 *  - `nivaro_ai_spend_days` — one row per day × dimension (model | feature |
 *    user) × key: calls, cost and tokens rolled up from the call log, which is
 *    pruned after 30 days. Spend forecasts and last month's figures read it.
 *  - `nivaro_ai_model_catalogue` — the models the provider/gateway answered
 *    for, with first/last seen and when one disappeared; `trial` keeps the
 *    side-by-side that ran automatically for a new id.
 *
 * Guarded and additive. The code degrades to "no history" while these are
 * missing (hasTable/hasColumn probes, cached).
 */
export async function up(knex: Knex): Promise<void> {
  if (
    (await knex.schema.hasTable('nivaro_ai_calls')) &&
    !(await knex.schema.hasColumn('nivaro_ai_calls', 'prompt_parts'))
  ) {
    await knex.schema.alterTable('nivaro_ai_calls', (t) => {
      t.text('prompt_parts').nullable()
    })
  }
  if (!(await knex.schema.hasTable('nivaro_ai_spend_days'))) {
    await knex.schema.createTable('nivaro_ai_spend_days', (t) => {
      t.bigIncrements('id')
      t.string('day', 10).notNullable() // YYYY-MM-DD (UTC)
      t.string('dim', 10).notNullable() // model | feature | user
      t.string('key', 120).notNullable()
      t.integer('calls').notNullable().defaultTo(0)
      t.decimal('cost_usd', 14, 6).notNullable().defaultTo(0)
      t.bigInteger('input_tokens').notNullable().defaultTo(0)
      t.bigInteger('output_tokens').notNullable().defaultTo(0)
      t.bigInteger('cached_tokens').notNullable().defaultTo(0)
      t.unique(['day', 'dim', 'key'], { indexName: 'uq_ai_spend_days' })
    })
  }
  if (!(await knex.schema.hasTable('nivaro_ai_model_catalogue'))) {
    await knex.schema.createTable('nivaro_ai_model_catalogue', (t) => {
      t.bigIncrements('id')
      t.string('model_id', 120).notNullable()
      t.string('source', 10).notNullable() // list | probe
      t.string('status', 10).notNullable() // available | retired
      t.dateTime('first_seen').notNullable()
      t.dateTime('last_seen').notNullable()
      t.dateTime('retired_at').nullable()
      t.dateTime('trial_at').nullable() // when the automatic side-by-side ran
      t.text('trial').nullable() // JSON: compare + replay summary
      t.unique(['model_id'], { indexName: 'uq_ai_model_catalogue' })
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_ai_model_catalogue')
  await knex.schema.dropTableIfExists('nivaro_ai_spend_days')
  if (await knex.schema.hasColumn('nivaro_ai_calls', 'prompt_parts')) {
    await knex.schema.alterTable('nivaro_ai_calls', (t) => {
      t.dropColumn('prompt_parts')
    })
  }
}
