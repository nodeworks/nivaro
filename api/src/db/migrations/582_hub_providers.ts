import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub third-party providers (GitHub/Actions, AWS, Vercel, Auth0, Expo, extensions'):
 * connections to outside accounts and the app parts the Hub manages there. Created on every
 * install, used only in hub mode (HUB=on). No foreign keys; each table is skipped when it already
 * exists. Spec: docs/superpowers/specs/2026-11-26-hub-providers-design.md.
 *
 *  - nivaro_hub_connections       one authenticated account at a provider (a GitHub org, an AWS
 *                                 account + allowed regions, a Vercel team…): non-secret `config`
 *                                 JSON, every secret field in ONE sealed `secret` (sealSecret of
 *                                 a JSON object) + `secret_keys` (the names of the secret fields
 *                                 that are set, for per-field masks), status + the last Test.
 *  - nivaro_hub_app_connections   which connections an app's owners may use (admin-set).
 *  - nivaro_hub_resources         one managed (or adopted) resource: type, provider id, scope
 *                                 (app + environment, or shared), desired + observed JSON, drift,
 *                                 tags, refs; `deleted_at` keeps a deleted one as history. The
 *                                 (connection_id, type, external_id) index is plain, not unique:
 *                                 a deleted row may share the id with a live one, so the store
 *                                 checks "one live row per provider id" itself.
 *  - nivaro_hub_resource_changes  one planned set of operations: plan JSON + plan_hash, status
 *                                 (planned → pending_approval → applying → applied | failed |
 *                                 interrupted | cancelled | declined), steps JSON (before-state,
 *                                 provider answer, snapshot), run key + heartbeat, who.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_hub_connections'))) {
    await knex.schema.createTable('nivaro_hub_connections', (t) => {
      t.increments('id').primary()
      t.string('provider', 32).notNullable()
      t.string('name', 120).notNullable()
      longText(t, knex, 'config').nullable()
      longText(t, knex, 'secret').nullable()
      t.string('secret_keys', 1000).nullable()
      t.string('status', 16).notNullable().defaultTo('untested')
      t.dateTime('last_test_at').nullable()
      longText(t, knex, 'last_test').nullable()
      t.uuid('created_by').nullable()
      t.uuid('updated_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.index(['provider'], 'ix_nivaro_hub_connections_provider')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_app_connections'))) {
    await knex.schema.createTable('nivaro_hub_app_connections', (t) => {
      t.increments('id').primary()
      t.integer('app_id').notNullable()
      t.integer('connection_id').notNullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.unique(['app_id', 'connection_id'], { indexName: 'ux_nivaro_hub_app_connections' })
      t.index(['connection_id'], 'ix_nivaro_hub_app_connections_conn')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_resources'))) {
    await knex.schema.createTable('nivaro_hub_resources', (t) => {
      t.increments('id').primary()
      t.integer('connection_id').notNullable()
      t.string('provider', 32).notNullable()
      t.string('type', 64).notNullable()
      t.string('external_id', 512).nullable()
      t.string('name', 255).nullable()
      t.string('scope', 8).notNullable().defaultTo('app')
      t.integer('app_id').nullable()
      t.integer('environment_id').nullable()
      longText(t, knex, 'desired').nullable()
      longText(t, knex, 'observed').nullable()
      t.boolean('drift').notNullable().defaultTo(false)
      t.dateTime('observed_at').nullable()
      longText(t, knex, 'tags').nullable()
      longText(t, knex, 'refs').nullable()
      t.uuid('created_by').nullable()
      t.boolean('adopted').notNullable().defaultTo(false)
      t.dateTime('deleted_at').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.index(['app_id', 'environment_id'], 'ix_nivaro_hub_resources_app_env')
      t.index(['connection_id', 'type', 'external_id'], 'ix_nivaro_hub_resources_ext')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_resource_changes'))) {
    await knex.schema.createTable('nivaro_hub_resource_changes', (t) => {
      t.increments('id').primary()
      t.integer('connection_id').notNullable()
      t.integer('app_id').nullable()
      t.integer('environment_id').nullable()
      t.string('scope', 8).notNullable().defaultTo('app')
      t.string('status', 24).notNullable().defaultTo('planned')
      longText(t, knex, 'plan').nullable()
      t.string('plan_hash', 64).nullable()
      longText(t, knex, 'steps').nullable()
      t.uuid('requested_by').nullable()
      t.uuid('approved_by').nullable()
      t.string('decline_reason', 500).nullable()
      t.string('run_key', 64).nullable()
      t.dateTime('heartbeat_at').nullable()
      t.string('error_code', 64).nullable()
      t.string('error', 1000).nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('finished_at').nullable()
      t.index(['app_id', 'environment_id', 'id'], 'ix_nivaro_hub_resource_changes_app')
      t.index(['connection_id', 'id'], 'ix_nivaro_hub_resource_changes_conn')
      t.index(['status'], 'ix_nivaro_hub_resource_changes_status')
    })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: tables may hold live hub data.
}
