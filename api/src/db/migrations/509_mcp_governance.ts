import type { Knex } from 'knex'
import { isMssql, utcNow } from '../dialect.js'

/**
 * MCP governance (#3205 per-connection scope, #3214 role tool kits, #3206 composite tool
 * suggestions, #3215 tool contract tests):
 *
 *   nivaro_mcp_connection_scopes — one row per MCP connection key (`o<grant uuid>` an OAuth
 *     connection, `k<id>` an API key): an optional kit, tool allowlist, collection allowlist and
 *     action list, each JSON (NULL = no limit there). Always NARROWER than the person: the
 *     request layer intersects it with what the credential already allows. `locked` = set by
 *     an administrator (the owner can no longer change it). Environment-specific (grant ids live
 *     in Redis): the nightly promote-config must never copy it.
 *   nivaro_mcp_tool_kits — administrator-defined tool kits beside the built-in ones (buyer, ops,
 *     admin live in code). Config.
 *   nivaro_mcp_contract_tests — a saved real tool call (tool, arguments, the input schema and the
 *     output shape it had) re-run as a regression test. Config.
 *   nivaro_mcp_tool_suggestion_dismissals — composite-tool suggestions an administrator waved off.
 *
 * Every JSON column is nvarchar(max) on SQL Server. No FKs (owners/updaters are informational;
 * a connection outlives nothing it points at).
 */
const SCOPES = 'nivaro_mcp_connection_scopes'
const KITS = 'nivaro_mcp_tool_kits'
const TESTS = 'nivaro_mcp_contract_tests'
const DISMISSALS = 'nivaro_mcp_tool_suggestion_dismissals'

function json(t: Knex.CreateTableBuilder, name: string, mssql: boolean, notNull = false) {
  const col = mssql ? t.specificType(name, 'nvarchar(max)') : t.text(name, 'longtext')
  if (notNull) col.notNullable()
  else col.nullable()
}

function stamps(t: Knex.CreateTableBuilder, knex: Knex, mssql: boolean, names: string[]) {
  for (const name of names) {
    ;(mssql ? t.specificType(name, 'datetime2') : t.timestamp(name))
      .notNullable()
      .defaultTo(utcNow(knex))
  }
}

export async function up(knex: Knex): Promise<void> {
  const mssql = isMssql(knex)

  if (!(await knex.schema.hasTable(SCOPES))) {
    await knex.schema.createTable(SCOPES, (t) => {
      t.string('conn', 48).notNullable().primary()
      t.string('kit', 48).nullable()
      json(t, 'tools', mssql)
      json(t, 'collections', mssql)
      json(t, 'actions', mssql)
      t.boolean('locked').notNullable().defaultTo(false)
      t.string('note', 300).nullable()
      t.uuid('user').nullable()
      t.uuid('updated_by').nullable()
      stamps(t, knex, mssql, ['created_at', 'updated_at'])
      t.index(['kit'], 'ix_mcp_scope_kit')
      t.index(['user'], 'ix_mcp_scope_user')
    })
  }

  if (!(await knex.schema.hasTable(KITS))) {
    await knex.schema.createTable(KITS, (t) => {
      t.string('key', 48).notNullable().primary()
      t.string('label', 80).notNullable()
      t.string('description', 500).nullable()
      json(t, 'tools', mssql, true)
      json(t, 'collections', mssql)
      json(t, 'actions', mssql)
      t.integer('sort').notNullable().defaultTo(0)
      t.uuid('created_by').nullable()
      t.uuid('updated_by').nullable()
      stamps(t, knex, mssql, ['created_at', 'updated_at'])
    })
  }

  if (!(await knex.schema.hasTable(TESTS))) {
    await knex.schema.createTable(TESTS, (t) => {
      t.increments('id').primary()
      t.string('name', 120).notNullable()
      t.string('tool', 64).notNullable()
      json(t, 'arguments', mssql, true)
      json(t, 'input_schema', mssql, true)
      json(t, 'output_shape', mssql, true)
      t.boolean('expect_error').notNullable().defaultTo(false)
      t.string('source', 16).notNullable().defaultTo('console')
      t.string('source_ref', 64).nullable()
      t.boolean('enabled').notNullable().defaultTo(true)
      t.uuid('created_by').nullable()
      stamps(t, knex, mssql, ['created_at', 'updated_at'])
      ;(mssql ? t.specificType('last_run_at', 'datetime2') : t.timestamp('last_run_at')).nullable()
      t.string('last_status', 12).nullable()
      json(t, 'last_result', mssql)
      t.integer('last_ms').nullable()
      t.index(['tool'], 'ix_mcp_ct_tool')
    })
  }

  if (!(await knex.schema.hasTable(DISMISSALS))) {
    await knex.schema.createTable(DISMISSALS, (t) => {
      t.string('pattern_key', 200).notNullable().primary()
      t.uuid('dismissed_by').nullable()
      stamps(t, knex, mssql, ['dismissed_at'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const table of [DISMISSALS, TESTS, KITS, SCOPES])
    if (await knex.schema.hasTable(table)) await knex.schema.dropTable(table)
}
