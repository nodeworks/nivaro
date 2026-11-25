import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub placement (ideas 48, 49, 50): hosts grouped in regions, cost chargeback per app, and
 * other Hubs this Hub reads (read only). Created on every install, used only in hub mode. No
 * foreign keys; each table is skipped when it already exists (guarded, additive, all five
 * engines; unique indexes declared in createTable, names under MySQL's 64 characters).
 *
 *  - nivaro_hub_regions          a group of Docker hosts (a region, a data centre, a rack): key,
 *                                name, a cost factor in percent (100 = the rates as set) and a
 *                                note. A host is a Docker driver (one Hub agent).
 *  - nivaro_hub_region_drivers   which region a Docker driver (host) belongs to, one row per
 *                                driver, with an optional label shown beside the driver's name.
 *  - nivaro_hub_app_cost_centers per app: the department and cost centre its costs are charged
 *                                to (the chargeback report groups by them).
 *  - nivaro_hub_peers            another Nivaro Hub this Hub reads: its https origin and an API
 *                                key of that Hub with the hub:read scope, sealed with this Hub's
 *                                ENCRYPTION_KEY (never answered back), and the last read's
 *                                outcome. No action is ever sent to a peer.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_hub_regions'))) {
    await knex.schema.createTable('nivaro_hub_regions', (t) => {
      t.increments('id').primary()
      t.string('key', 64).notNullable()
      t.string('name', 120).notNullable()
      t.string('note', 500).nullable()
      t.integer('cost_percent').notNullable().defaultTo(100)
      t.integer('position').notNullable().defaultTo(0)
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['key'], { indexName: 'ux_nivaro_hub_regions_key' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_region_drivers'))) {
    await knex.schema.createTable('nivaro_hub_region_drivers', (t) => {
      t.increments('id').primary()
      t.integer('driver_id').notNullable()
      t.integer('region_id').notNullable()
      t.string('label', 120).nullable()
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['driver_id'], { indexName: 'ux_nivaro_hub_region_drivers_drv' })
      t.index(['region_id'], 'ix_nivaro_hub_region_drivers_reg')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_app_cost_centers'))) {
    await knex.schema.createTable('nivaro_hub_app_cost_centers', (t) => {
      t.increments('id').primary()
      t.integer('app_id').notNullable()
      t.string('department', 120).nullable()
      t.string('cost_center', 120).nullable()
      t.uuid('updated_by').nullable()
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['app_id'], { indexName: 'ux_nivaro_hub_app_cost_centers_app' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_peers'))) {
    await knex.schema.createTable('nivaro_hub_peers', (t) => {
      t.increments('id').primary()
      t.string('name', 120).notNullable()
      t.string('base_url', 300).notNullable()
      longText(t, knex, 'token').nullable()
      t.boolean('enabled').notNullable().defaultTo(true)
      t.dateTime('last_ok_at').nullable()
      t.dateTime('last_tried_at').nullable()
      t.string('last_error', 64).nullable()
      t.integer('last_count').nullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['base_url'], { indexName: 'ux_nivaro_hub_peers_url' })
    })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: tables may hold live hub data.
}
