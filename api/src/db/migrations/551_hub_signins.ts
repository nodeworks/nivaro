import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Nivaro Hub phase 7: who signed in where, and the lookup key for an environment's hub token.
 * Created on every install, used only in hub mode. No foreign keys; each step is skipped when it
 * already exists. Unique indexes are declared in createTable (portable on all five engines).
 *
 *  - nivaro_hub_signins                      one row per person per environment (first/last seen)
 *  - nivaro_hub_environments.hub_token_lookup  non-secret lookup of a sealed hub token
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_hub_signins'))) {
    await knex.schema.createTable('nivaro_hub_signins', (t) => {
      t.increments('id').primary()
      t.string('identity_key', 200).notNullable()
      t.uuid('hub_user_id').nullable()
      t.string('email', 320).nullable()
      t.integer('app_id').notNullable()
      t.integer('environment_id').notNullable()
      t.string('via', 16).notNullable()
      t.dateTime('first_seen').nullable().defaultTo(utcNow(knex))
      t.dateTime('last_seen').nullable().defaultTo(utcNow(knex))
      t.unique(['identity_key', 'environment_id'], { indexName: 'ux_nivaro_hub_signin' })
      t.index(['hub_user_id'], 'ix_nivaro_hub_signin_user')
      t.index(['last_seen'], 'ix_nivaro_hub_signin_seen')
    })
  }

  if (
    (await knex.schema.hasTable('nivaro_hub_environments')) &&
    !(await knex.schema.hasColumn('nivaro_hub_environments', 'hub_token_lookup'))
  ) {
    await knex.schema.alterTable('nivaro_hub_environments', (t) => {
      t.string('hub_token_lookup', 64).nullable()
    })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: tables may hold live hub data.
}
