import type { Knex } from 'knex'

/**
 * AI provider choice, all of it under Settings → AI Features: Anthropic
 * directly (the original API-key path) or an OpenAI-/Anthropic-compatible
 * model gateway reached with OAuth client-credentials.
 *
 *   ai_provider              'anthropic' | 'gateway'
 *   ai_gateway_base_url      gateway root, e.g. https://…/orgs/efp/modelgws/efp-092026
 *   ai_gateway_token_url     OAuth token endpoint (query string allowed, e.g. ?scope=…)
 *   ai_gateway_client_id     sent as X-Client-Id (header-credential token endpoints)
 *   ai_gateway_client_secret sent as X-Client-Secret; masked on GET like the other secrets
 *   ai_gateway_format        'openai' (POST <base>/openai/v1/chat/completions)
 *                            | 'anthropic' (<base>/anthropic, native Messages API)
 *   ai_gateway_model         the model id THE GATEWAY knows (e.g. claude-4-5-haiku);
 *                            every call site's model is replaced with it
 *
 * An earlier cut of this migration keyed the gateway on an External API row
 * (ai_gateway_external_api); that column is dropped where it landed.
 */
export async function up(knex: Knex): Promise<void> {
  const add = async (col: string, cb: (t: Knex.AlterTableBuilder) => void) => {
    if (!(await knex.schema.hasColumn('nivaro_settings', col))) {
      await knex.schema.alterTable('nivaro_settings', cb)
    }
  }
  await add('ai_provider', (t) => t.string('ai_provider', 20).defaultTo('anthropic'))
  await add('ai_gateway_base_url', (t) => t.string('ai_gateway_base_url', 500).nullable())
  await add('ai_gateway_token_url', (t) => t.string('ai_gateway_token_url', 500).nullable())
  await add('ai_gateway_client_id', (t) => t.string('ai_gateway_client_id', 200).nullable())
  await add('ai_gateway_client_secret', (t) => t.string('ai_gateway_client_secret', 500).nullable())
  await add('ai_gateway_format', (t) => t.string('ai_gateway_format', 20).defaultTo('openai'))
  await add('ai_gateway_model', (t) => t.string('ai_gateway_model', 100).nullable())
  if (await knex.schema.hasColumn('nivaro_settings', 'ai_gateway_external_api')) {
    await knex.schema.alterTable('nivaro_settings', (t) => t.dropColumn('ai_gateway_external_api'))
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const col of [
    'ai_provider',
    'ai_gateway_base_url',
    'ai_gateway_token_url',
    'ai_gateway_client_id',
    'ai_gateway_client_secret',
    'ai_gateway_format',
    'ai_gateway_model'
  ]) {
    if (await knex.schema.hasColumn('nivaro_settings', col)) {
      await knex.schema.alterTable('nivaro_settings', (t) => t.dropColumn(col))
    }
  }
}
