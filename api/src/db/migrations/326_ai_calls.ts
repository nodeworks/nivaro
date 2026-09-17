import type { Knex } from 'knex'

/**
 * Per-call AI log — the /ai-analytics counterpart of nivaro_api_logs.
 *
 * One row per `messages.create` through `getAiClient()`, whatever the feature
 * (Ask AI runs 6–12 per question; generate/summarize/brief run one). Bodies are
 * capped copies for debugging a bad answer; pruned after 30 days.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_ai_calls')) return
  await knex.schema.createTable('nivaro_ai_calls', (t) => {
    t.bigIncrements('id')
    t.dateTime('created_at').notNullable()
    t.string('request_id', 40).nullable() // one HTTP request = one Ask AI question
    t.uuid('user').nullable()
    t.string('feature', 60).notNullable() // chat | chat-bot | generate | summarize | brief | …
    t.string('route', 300).nullable()
    t.string('provider', 30).notNullable() // anthropic | gateway-openai | gateway-anthropic
    t.string('model', 100).notNullable()
    t.string('status', 10).notNullable() // ok | error
    t.integer('latency_ms').notNullable()
    t.integer('input_tokens').nullable()
    t.integer('output_tokens').nullable()
    t.integer('cache_read_tokens').nullable()
    t.integer('cache_write_tokens').nullable()
    t.decimal('cost_usd', 12, 6).nullable()
    t.string('stop_reason', 40).nullable()
    t.integer('tool_calls').nullable()
    t.integer('rounds').nullable() // messages in the request — a tool loop grows it
    t.text('request').nullable() // capped JSON {system, messages, tools}
    t.text('response').nullable() // capped JSON content blocks
    t.string('error', 1000).nullable()
    t.index(['created_at'], 'ix_ai_calls_created')
    t.index(['request_id'], 'ix_ai_calls_request')
    t.index(['user', 'created_at'], 'ix_ai_calls_user')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_ai_calls')
}
