import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub providers, Wave 2 framework (Task 13): what a managed resource hands out and where it
 * goes, and the routes Hub events go out through. Created on every install, used only in hub mode
 * (HUB=on). No foreign keys (the Hub checks the rows itself); each table is skipped when it
 * already exists. Spec: docs/superpowers/specs/2026-11-26-hub-providers-design.md ("Wave 2
 * providers").
 *
 *  - nivaro_hub_resource_outputs   one output value of a resource (a DSN, an API key, a URL):
 *                                  `value` SEALED (sealSecret), `fingerprint` = HMAC of the plain
 *                                  value (stable, keyed by ENCRYPTION_KEY) so a change is seen
 *                                  without opening it. One row per (resource_id, key).
 *  - nivaro_hub_resource_bindings  where an output goes: an environment's stack setting, stack
 *                                  secret (the stack then needs Apply now; never applied by
 *                                  itself) or an allow-listed app setting (through the hub link).
 *                                  One source per destination: unique (environment_id, target,
 *                                  target_key). last_fingerprint = what was pushed last.
 *  - nivaro_hub_notify_routes      Hub events (deploys, incidents, approvals, drift, failed
 *                                  backups, expiring certificates…) → a sending resource (Slack,
 *                                  Teams, PagerDuty…): scope hub (every app) or app, events JSON
 *                                  list, the last send and the last failure.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_hub_resource_outputs'))) {
    await knex.schema.createTable('nivaro_hub_resource_outputs', (t) => {
      t.increments('id').primary()
      t.integer('resource_id').notNullable()
      t.string('key', 64).notNullable()
      longText(t, knex, 'value').nullable()
      t.string('fingerprint', 64).nullable()
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['resource_id', 'key'], { indexName: 'ux_nivaro_hub_resource_outputs' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_resource_bindings'))) {
    await knex.schema.createTable('nivaro_hub_resource_bindings', (t) => {
      t.increments('id').primary()
      t.integer('resource_id').notNullable()
      t.string('output_key', 64).notNullable()
      t.integer('environment_id').notNullable()
      t.string('target', 16).notNullable()
      t.string('target_key', 128).notNullable()
      t.dateTime('last_pushed_at').nullable()
      t.string('last_fingerprint', 64).nullable()
      t.string('last_error', 1000).nullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['environment_id', 'target', 'target_key'], {
        indexName: 'ux_nivaro_hub_resource_bindings_dest'
      })
      t.index(['resource_id'], 'ix_nivaro_hub_resource_bindings_res')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_notify_routes'))) {
    await knex.schema.createTable('nivaro_hub_notify_routes', (t) => {
      t.increments('id').primary()
      t.string('name', 120).nullable()
      t.string('scope', 8).notNullable().defaultTo('hub')
      t.integer('app_id').nullable()
      longText(t, knex, 'events').nullable()
      t.integer('resource_id').notNullable()
      t.boolean('enabled').notNullable().defaultTo(true)
      t.dateTime('last_sent_at').nullable()
      t.dateTime('last_error_at').nullable()
      t.string('last_error', 1000).nullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.index(['scope', 'app_id'], 'ix_nivaro_hub_notify_routes_scope')
      t.index(['resource_id'], 'ix_nivaro_hub_notify_routes_res')
    })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: tables may hold live hub data.
}
