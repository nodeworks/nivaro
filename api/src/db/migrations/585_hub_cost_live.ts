import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Nivaro Hub live costs and estimates (Task 44a). Created on every install, used only in hub mode
 * (HUB=on). No foreign keys; each table is skipped when it already exists. Figures only — never a
 * secret, a provider body or a person's data. Spec: docs/superpowers/specs/2026-11-26-hub-providers-design.md
 * ("Live costs and estimates").
 *
 *  - nivaro_hub_price_cache    one price the price book read (provider + sku key + region): the
 *                              unit and its price in micro-units of `currency` (bigint), the
 *                              provider's own "as of" date and when the Hub fetched it. A hit
 *                              younger than 7 days is used as it is; older ones are fetched again.
 *  - nivaro_hub_cost_runrate   one figures-only row per sample (every 15 minutes, after the
 *                              capacity sample run) per managed resource (kind `resource`) and
 *                              per environment's stack (kind `stack`): its run-rate in cents a
 *                              month, the estimate's basis and confidence. Kept 400 days; month
 *                              to date = the rows integrated from the first of the month.
 *  - nivaro_hub_cost_budgets   a monthly budget per app (cents), an optional per-app auto-approve
 *                              limit for owner changes, and which over-budget alert was last sent
 *                              (`last_alert_month` YYYY-MM + `last_alert_pct` 80|100) so each
 *                              threshold alerts once per month.
 *
 * The Hub-wide auto-approve limit lives in nivaro_extension_settings (`nivaro-hub` / `costs`).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_hub_price_cache'))) {
    await knex.schema.createTable('nivaro_hub_price_cache', (t) => {
      t.increments('id').primary()
      t.string('provider', 32).notNullable()
      t.string('sku_key', 200).notNullable()
      t.string('region', 32).notNullable()
      t.string('unit', 32).notNullable()
      t.bigInteger('unit_micros').notNullable()
      t.string('currency', 3).notNullable().defaultTo('USD')
      t.string('as_of', 32).nullable()
      t.dateTime('fetched_at').notNullable().defaultTo(utcNow(knex))
      t.unique(['provider', 'sku_key', 'region'], { indexName: 'ux_nivaro_hub_price_cache' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_cost_runrate'))) {
    await knex.schema.createTable('nivaro_hub_cost_runrate', (t) => {
      t.increments('id').primary()
      t.dateTime('sampled_at').notNullable()
      t.integer('app_id').nullable()
      t.integer('environment_id').nullable()
      t.string('provider', 32).nullable()
      t.integer('resource_id').nullable()
      t.string('kind', 16).notNullable()
      t.bigInteger('monthly_cents').notNullable()
      t.string('basis', 16).notNullable()
      t.string('confidence', 16).notNullable()
      t.index(['sampled_at'], 'ix_nivaro_hub_cost_runrate_at')
      t.index(['app_id', 'sampled_at'], 'ix_nivaro_hub_cost_runrate_app')
      t.index(['resource_id', 'sampled_at'], 'ix_nivaro_hub_cost_runrate_res')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_cost_budgets'))) {
    await knex.schema.createTable('nivaro_hub_cost_budgets', (t) => {
      t.increments('id').primary()
      t.integer('app_id').notNullable()
      t.bigInteger('monthly_cents').notNullable().defaultTo(0)
      t.bigInteger('auto_approve_under_cents').nullable()
      t.string('last_alert_month', 7).nullable()
      t.integer('last_alert_pct').nullable()
      t.uuid('updated_by').nullable()
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['app_id'], { indexName: 'ux_nivaro_hub_cost_budgets_app' })
    })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: the tables may hold an administrator's budgets and the run-rate history.
}
