import type { Knex } from 'knex'

/**
 * Integrations batch B — #66 mock mode per instance, #67 inbound request
 * replay, #74 endpoint contract tests, #88 inbound mapping editor, #89
 * per-instance credentials. Every step is hasTable/hasColumn-guarded and
 * additive, so an older image serves fine against this schema.
 */
export async function up(knex: Knex): Promise<void> {
  // #67 — the request body of inbound integration writes (token / api-key
  // callers only, JSON, capped) so a rejected push can be replayed.
  if (
    (await knex.schema.hasTable('nivaro_api_logs')) &&
    !(await knex.schema.hasColumn('nivaro_api_logs', 'request_body'))
  ) {
    await knex.schema.alterTable('nivaro_api_logs', (t) => {
      t.text('request_body').nullable()
    })
  }

  // #66 + #89 — per-instance mock rules and credential/base-url overrides,
  // keyed by NIVARO_INSTANCE (settings-overrides instanceKey()).
  if (await knex.schema.hasTable('nivaro_external_apis')) {
    if (!(await knex.schema.hasColumn('nivaro_external_apis', 'mock_config'))) {
      await knex.schema.alterTable('nivaro_external_apis', (t) => {
        t.text('mock_config').nullable()
      })
    }
    if (!(await knex.schema.hasColumn('nivaro_external_apis', 'instance_overrides'))) {
      await knex.schema.alterTable('nivaro_external_apis', (t) => {
        t.text('instance_overrides').nullable()
      })
    }
  }

  // #74 — a contract per endpoint + the last run's verdict.
  if (await knex.schema.hasTable('nivaro_external_api_endpoints')) {
    if (!(await knex.schema.hasColumn('nivaro_external_api_endpoints', 'contract'))) {
      await knex.schema.alterTable('nivaro_external_api_endpoints', (t) => {
        t.text('contract').nullable()
        t.datetime('contract_last_run').nullable()
        t.boolean('contract_last_ok').nullable()
        t.text('contract_last_detail').nullable()
      })
    }
  }

  // #88 — inbound mappings: a named key an integration POSTs to, a header-
  // rule map (the import-template rule format) and a target collection.
  if (!(await knex.schema.hasTable('nivaro_inbound_mappings'))) {
    await knex.schema.createTable('nivaro_inbound_mappings', (t) => {
      t.increments('id').primary()
      t.string('key', 100).notNullable().unique()
      t.string('label', 255).notNullable()
      t.string('collection', 255).notNullable()
      t.string('mode', 20).notNullable().defaultTo('create')
      t.text('upsert_keys').nullable()
      t.text('rules').nullable()
      t.boolean('is_active').notNullable().defaultTo(true)
      t.uuid('created_by').nullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
      t.datetime('created_at').notNullable().defaultTo(knex.fn.now())
      t.datetime('updated_at').notNullable().defaultTo(knex.fn.now())
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_inbound_mappings')) {
    await knex.schema.dropTable('nivaro_inbound_mappings')
  }
  if (await knex.schema.hasColumn('nivaro_external_api_endpoints', 'contract')) {
    await knex.schema.alterTable('nivaro_external_api_endpoints', (t) => {
      t.dropColumn('contract')
      t.dropColumn('contract_last_run')
      t.dropColumn('contract_last_ok')
      t.dropColumn('contract_last_detail')
    })
  }
  if (await knex.schema.hasColumn('nivaro_external_apis', 'mock_config')) {
    await knex.schema.alterTable('nivaro_external_apis', (t) => {
      t.dropColumn('mock_config')
    })
  }
  if (await knex.schema.hasColumn('nivaro_external_apis', 'instance_overrides')) {
    await knex.schema.alterTable('nivaro_external_apis', (t) => {
      t.dropColumn('instance_overrides')
    })
  }
  if (await knex.schema.hasColumn('nivaro_api_logs', 'request_body')) {
    await knex.schema.alterTable('nivaro_api_logs', (t) => {
      t.dropColumn('request_body')
    })
  }
}
