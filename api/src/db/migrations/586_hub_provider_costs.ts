import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Nivaro Hub provider cost feed and domain watch (Task 34). Created on every install, used only in
 * hub mode (HUB=on). No foreign keys; each table is skipped when it already exists. Figures and
 * names only — never a secret or a provider body. Spec:
 * docs/superpowers/specs/2026-11-26-hub-providers-design.md ("Wave 3 providers").
 *
 *  - nivaro_hub_provider_costs  one row per connection + day (`date` = YYYY-MM-DD text, UTC) + app
 *                               + managed resource + service + record type + currency: what the
 *                               provider billed, in cents (bigint, negative for a credit). Written
 *                               by the daily `hub-provider-costs` job from an adapter's `costs()`;
 *                               a re-run replaces the days it read again, never adds to them.
 *                               `source` says how the row found its app: `resource` (a managed
 *                               resource's provider id), `tag` (the `nivaro-hub:app` tag) or
 *                               `none` (unassigned). `record_type` = usage | tax | credit |
 *                               discount | refund (the price book learns tax and discount rates
 *                               from it). Kept 400 days.
 *  - nivaro_hub_domain_checks   one row per registrar domain resource the Hub manages: expiry,
 *                               auto-renew, transfer lock, state and which warning (45 / 14 days,
 *                               0 = expired) was last sent, so each threshold warns once.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_hub_provider_costs'))) {
    await knex.schema.createTable('nivaro_hub_provider_costs', (t) => {
      t.increments('id').primary()
      t.integer('connection_id').notNullable()
      t.string('provider', 32).notNullable()
      t.string('date', 10).notNullable()
      t.integer('app_id').nullable()
      t.integer('resource_id').nullable()
      t.string('service', 64).notNullable().defaultTo('')
      t.string('record_type', 16).notNullable().defaultTo('usage')
      t.bigInteger('amount_cents').notNullable()
      t.string('currency', 3).notNullable().defaultTo('USD')
      t.string('source', 16).notNullable()
      t.dateTime('fetched_at').notNullable().defaultTo(utcNow(knex))
      t.unique(
        ['connection_id', 'date', 'app_id', 'resource_id', 'service', 'record_type', 'currency'],
        { indexName: 'ux_nivaro_hub_provider_costs' }
      )
      t.index(['connection_id', 'date'], 'ix_nivaro_hub_provider_costs_conn')
      t.index(['app_id', 'date'], 'ix_nivaro_hub_provider_costs_app')
      t.index(['date'], 'ix_nivaro_hub_provider_costs_date')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_domain_checks'))) {
    await knex.schema.createTable('nivaro_hub_domain_checks', (t) => {
      t.increments('id').primary()
      t.integer('resource_id').notNullable()
      t.integer('connection_id').notNullable()
      t.integer('app_id').nullable()
      t.string('domain', 253).notNullable()
      t.dateTime('expires_at').nullable()
      t.boolean('auto_renew').nullable()
      t.boolean('locked').nullable()
      t.string('state', 16).notNullable().defaultTo('ok')
      t.string('error_code', 64).nullable()
      t.integer('warned_level').nullable()
      t.dateTime('checked_at').nullable()
      t.unique(['resource_id'], { indexName: 'ux_nivaro_hub_domain_checks_res' })
    })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: the tables hold the billed history and the domain warnings already sent.
}
