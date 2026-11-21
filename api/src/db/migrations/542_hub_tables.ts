import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub (phase 1) tables. Created on every install, used only in hub mode (HUB on), empty
 * otherwise. No foreign keys: the hub service deletes children explicitly. Each table is skipped
 * when it exists. Unique indexes are declared in createTable (portable on all five engines) so
 * they exist only on a table made here.
 *
 *  - nivaro_hub_apps          an app the hub manages (key, name, sign-in mode, extension list)
 *  - nivaro_hub_app_owners    who may manage an app
 *  - nivaro_hub_drivers       how the hub reaches a deployment target (gitlab); secret is sealed
 *  - nivaro_hub_placements    where an environment runs (dedicated in phase 1)
 *  - nivaro_hub_environments  one deployment of an app; hub_token is sealed
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_hub_apps'))) {
    await knex.schema.createTable('nivaro_hub_apps', (t) => {
      t.increments('id').primary()
      t.string('key', 64).notNullable()
      t.string('name', 200).notNullable()
      t.string('signin_mode', 16).notNullable().defaultTo('direct')
      longText(t, knex, 'extensions').nullable()
      t.boolean('adopted').notNullable().defaultTo(false)
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['key'], { indexName: 'ux_nivaro_hub_apps_key' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_app_owners'))) {
    await knex.schema.createTable('nivaro_hub_app_owners', (t) => {
      t.increments('id').primary()
      t.integer('app_id').notNullable()
      t.uuid('user_id').notNullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['app_id', 'user_id'], { indexName: 'ux_nivaro_hub_owner' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_drivers'))) {
    await knex.schema.createTable('nivaro_hub_drivers', (t) => {
      t.increments('id').primary()
      t.string('kind', 16).notNullable()
      t.string('name', 200).notNullable()
      longText(t, knex, 'config').nullable()
      longText(t, knex, 'secret').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_placements'))) {
    await knex.schema.createTable('nivaro_hub_placements', (t) => {
      t.increments('id').primary()
      t.string('kind', 16).notNullable()
      t.integer('driver_id').nullable()
      longText(t, knex, 'target').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_environments'))) {
    await knex.schema.createTable('nivaro_hub_environments', (t) => {
      t.increments('id').primary()
      t.integer('app_id').notNullable()
      t.string('key', 64).notNullable()
      t.integer('position').notNullable().defaultTo(0)
      t.string('status', 24).notNullable().defaultTo('active')
      t.string('base_url', 500).notNullable()
      longText(t, knex, 'hostnames').nullable()
      t.integer('placement_id').nullable()
      t.string('version_pin', 64).nullable()
      longText(t, knex, 'extension_pins').nullable()
      t.string('db_ref', 200).nullable()
      longText(t, knex, 'hub_token').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['app_id', 'key'], { indexName: 'ux_nivaro_hub_env_app_key' })
    })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: tables may hold live hub data.
}
