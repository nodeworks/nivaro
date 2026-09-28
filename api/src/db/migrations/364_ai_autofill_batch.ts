import type { Knex } from 'knex'

/**
 * AI batch (2026-09-28):
 *  - nivaro_ai_collection_settings.autofill_hints — text — plain-language
 *    hints for "Fill from document" on that collection ("the fee table lists
 *    monthly amounts; the term is in section 3"). Rides the system prompt.
 *  - nivaro_ai_collection_settings.autofill_keyed_hints — text JSON
 *    `[{field, match, hints}]` — hints that apply once a relation field
 *    resolves to a record whose label contains `match` (a vendor's quirks).
 *  - nivaro_ai_collection_settings.autofill_thresholds — text JSON
 *    `{"_default": 0.4, "<field>": n}` — a proposed value under the
 *    threshold becomes an ask carrying the candidate instead of a fill.
 *  - nivaro_ai_autofill_events — one row per proposal a person acted on:
 *    what was proposed, what they kept, what they changed before Create,
 *    what was asked. Feeds the scorecard and the corrections memory.
 *  - nivaro_settings.ai_models — text JSON per-feature model map
 *    `{default, chat, extract, generate, summarize, embed}` replacing the
 *    three ai_gateway_*_model columns (seeded from them once, kept as the
 *    fallback for a database this migration never reached).
 *  - nivaro_settings.ai_answer_cache_minutes — int — identical standalone
 *    Ask AI questions by the same person answer from cache this long (blank
 *    = 15, 0 = off).
 */
export async function up(knex: Knex): Promise<void> {
  for (const col of ['autofill_hints', 'autofill_keyed_hints', 'autofill_thresholds']) {
    if (!(await knex.schema.hasColumn('nivaro_ai_collection_settings', col))) {
      await knex.schema.alterTable('nivaro_ai_collection_settings', (t) => {
        t.text(col).nullable()
      })
    }
  }
  if (!(await knex.schema.hasTable('nivaro_ai_autofill_events'))) {
    await knex.schema.createTable('nivaro_ai_autofill_events', (t) => {
      t.bigIncrements('id')
      t.datetime('created_at').notNullable()
      t.string('proposal_id', 40).notNullable()
      t.string('request_id', 40).nullable()
      t.uuid('user').nullable()
      t.string('collection', 255).notNullable()
      t.string('document_name', 300).nullable()
      t.string('file_id', 40).nullable()
      t.string('model', 100).nullable()
      t.integer('rounds').nullable()
      t.integer('latency_ms').nullable()
      t.decimal('cost_usd', 12, 6).nullable()
      t.integer('fields_proposed').notNullable().defaultTo(0)
      t.integer('fields_kept').notNullable().defaultTo(0)
      t.integer('fields_overridden').notNullable().defaultTo(0)
      t.integer('lines_proposed').notNullable().defaultTo(0)
      t.integer('lines_kept').notNullable().defaultTo(0)
      t.integer('asks').notNullable().defaultTo(0)
      t.integer('asks_resolved').notNullable().defaultTo(0)
      /** JSON: [{field, proposed, proposed_display, confidence, kept}] */
      t.text('proposed').nullable()
      /** JSON: [{field, proposed, proposed_display, final, final_display}] — stamped at Create. */
      t.text('overrides').nullable()
      t.string('record_id', 64).nullable()
      t.datetime('completed_at').nullable()
      t.index(['collection', 'created_at'], 'ix_ai_autofill_events_collection')
      t.index(['proposal_id'], 'ix_ai_autofill_events_proposal')
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_settings', 'ai_models'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('ai_models').nullable()
    })
    const row = (await knex('nivaro_settings')
      .where({ id: 1 })
      .first('ai_gateway_model', 'ai_gateway_chat_model', 'ai_gateway_extract_model')) as
      | Record<string, string | null>
      | undefined
    if (row) {
      const seed: Record<string, string> = {}
      if (row.ai_gateway_model) seed.default = row.ai_gateway_model
      if (row.ai_gateway_chat_model) seed.chat = row.ai_gateway_chat_model
      if (row.ai_gateway_extract_model) seed.extract = row.ai_gateway_extract_model
      if (Object.keys(seed).length) {
        await knex('nivaro_settings')
          .where({ id: 1 })
          .update({ ai_models: JSON.stringify(seed) })
      }
    }
  }
  if (!(await knex.schema.hasColumn('nivaro_settings', 'ai_answer_cache_minutes'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.integer('ai_answer_cache_minutes').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const col of ['autofill_hints', 'autofill_keyed_hints', 'autofill_thresholds']) {
    if (await knex.schema.hasColumn('nivaro_ai_collection_settings', col)) {
      await knex.schema.alterTable('nivaro_ai_collection_settings', (t) => t.dropColumn(col))
    }
  }
  if (await knex.schema.hasTable('nivaro_ai_autofill_events')) {
    await knex.schema.dropTable('nivaro_ai_autofill_events')
  }
  for (const col of ['ai_models', 'ai_answer_cache_minutes']) {
    if (await knex.schema.hasColumn('nivaro_settings', col)) {
      await knex.schema.alterTable('nivaro_settings', (t) => t.dropColumn(col))
    }
  }
}
