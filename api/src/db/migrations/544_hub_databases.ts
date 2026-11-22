import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub phase 3: database servers, databases and targets. Created on every install, used
 * only in hub mode. No foreign keys; every step is skipped when it already exists. Sealed JSON
 * columns (admin_secret, connection, secret) are never read through the items API.
 *
 *  - nivaro_hub_db_servers   a database server the Hub may create databases on
 *  - nivaro_hub_databases    one database made or adopted for an environment
 *  - nivaro_hub_targets      a place new apps are created (kind gitlab)
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_hub_db_servers'))) {
    await knex.schema.createTable('nivaro_hub_db_servers', (t) => {
      t.increments('id').primary()
      t.string('name', 200).notNullable()
      t.string('engine', 16).notNullable()
      t.string('host', 253).notNullable()
      t.integer('port').nullable()
      t.string('provision_mode', 16).notNullable().defaultTo('manual')
      longText(t, knex, 'admin_secret').nullable()
      t.string('ssl_mode', 16).nullable()
      t.boolean('trust_server_cert').notNullable().defaultTo(false)
      t.string('collation', 128).nullable()
      t.string('user_host', 64).nullable()
      t.string('notes', 1000).nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['name'], { indexName: 'ux_nivaro_hub_dbsrv_name' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_databases'))) {
    await knex.schema.createTable('nivaro_hub_databases', (t) => {
      t.increments('id').primary()
      t.integer('server_id').nullable()
      t.string('engine', 16).notNullable()
      t.string('host', 253).notNullable()
      t.integer('port').nullable()
      t.string('database_name', 128).notNullable()
      t.string('login_name', 128).nullable()
      longText(t, knex, 'connection').nullable()
      t.string('status', 16).notNullable().defaultTo('requested')
      t.boolean('adopted').notNullable().defaultTo(false)
      t.boolean('created_by_hub').notNullable().defaultTo(false)
      longText(t, knex, 'last_check').nullable()
      t.dateTime('checked_at').nullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.index(['host', 'database_name'], 'ix_nivaro_hub_db_name')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_targets'))) {
    await knex.schema.createTable('nivaro_hub_targets', (t) => {
      t.increments('id').primary()
      t.string('kind', 16).notNullable()
      t.string('name', 200).notNullable()
      longText(t, knex, 'config').notNullable()
      longText(t, knex, 'secret').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['name'], { indexName: 'ux_nivaro_hub_targets_name' })
    })
  }
}

// Additive only: a rollback keeps the tables (and what is in them) in place.
export async function down(): Promise<void> {}
