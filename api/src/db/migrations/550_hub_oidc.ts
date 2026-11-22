import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub phase 7: sign-in through the Hub (the Hub is an OpenID provider for its apps).
 * Created on every install, used only in hub mode. No foreign keys; each table is skipped when
 * it exists. Unique indexes are declared in createTable (portable on all five engines).
 *
 *  - nivaro_hub_oidc_keys     the Hub's signing keys (private_jwk is sealed)
 *  - nivaro_hub_oidc_clients  one OpenID client per environment (client_secret is sealed)
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_hub_oidc_keys'))) {
    await knex.schema.createTable('nivaro_hub_oidc_keys', (t) => {
      t.increments('id').primary()
      t.string('kid', 64).notNullable()
      t.string('alg', 16).notNullable().defaultTo('ES256')
      longText(t, knex, 'public_jwk').notNullable()
      longText(t, knex, 'private_jwk').notNullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('retired_at').nullable()
      t.unique(['kid'], { indexName: 'ux_nivaro_hub_oidc_kid' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_oidc_clients'))) {
    await knex.schema.createTable('nivaro_hub_oidc_clients', (t) => {
      t.increments('id').primary()
      t.integer('environment_id').notNullable()
      t.string('client_id', 64).notNullable()
      longText(t, knex, 'client_secret').notNullable()
      t.boolean('active').notNullable().defaultTo(true)
      t.uuid('created_by').nullable()
      t.dateTime('secret_rotated_at').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['environment_id'], { indexName: 'ux_nivaro_hub_oidc_env' })
      t.unique(['client_id'], { indexName: 'ux_nivaro_hub_oidc_client' })
    })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: tables may hold live hub data.
}
