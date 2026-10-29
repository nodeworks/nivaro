import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * App-managed stored procedures. A row in nivaro_managed_procedures holds the full body of one
 * dbo procedure Nivaro deploys (the full create-or-alter text) with ONE writer: the app's deploy, by
 * hash (body_hash = sha256 of the normalized body, services/managed-procedures/normalize.ts).
 * Every saved body also lands in nivaro_managed_procedure_versions, so undo is "deploy version
 * N". `dropped_at` marks a proc dropped in the app — the deploy step drops the live proc, and
 * the row (with its versions) is kept so the drop travels and can be undone.
 *
 * Both tables are configuration: they ride config snapshots and promote between environments
 * (dev → staging nightly, production at go-live). `deployed_hash` / `deployed_at` /
 * `deployed_by` describe the database the row lives in (what THIS database last got from
 * config), so they are dropped from snapshots and a restore or promote keeps the target's own
 * values. Import procedures stay on nivaro_import_definitions.procedure_body; the owner answer
 * (services/managed-procedures/owners.ts) unites the two.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_managed_procedures'))) {
    await knex.schema.createTable('nivaro_managed_procedures', (t) => {
      t.increments('id')
      /** The dbo procedure name (^[A-Za-z_][A-Za-z0-9_]*$). */
      t.string('name', 128).notNullable().unique()
      /** The full procedure text (create-or-alter form). */
      t.text('body').notNullable()
      /** sha256 hex of the normalized body. */
      t.string('body_hash', 64).notNullable()
      /** The current version number (the UI's "v3"). */
      t.integer('version').notNullable().defaultTo(1)
      /** What this database last got from config (normalized-body hash). */
      t.string('deployed_hash', 64).nullable()
      t.dateTime('deployed_at').nullable()
      /** Plain-text actor: a user id or `script:<name>` (no FK — it may name a script). */
      t.string('deployed_by', 120).nullable()
      t.string('description', 500).nullable()
      /** Who adopted it (e.g. `efp-ops`); NULL when made in the app. */
      t.string('owner', 120).nullable()
      t.dateTime('updated_at').notNullable().defaultTo(utcNow(knex))
      t.uuid('updated_by').nullable().references('id').inTable('nivaro_users')
      /** Set when dropped in the app; the deploy step drops the live proc. */
      t.dateTime('dropped_at').nullable()
    })
  }
  if (!(await knex.schema.hasTable('nivaro_managed_procedure_versions'))) {
    await knex.schema.createTable('nivaro_managed_procedure_versions', (t) => {
      t.increments('id')
      t.integer('procedure_id').notNullable().references('id').inTable('nivaro_managed_procedures')
      t.integer('version').notNullable()
      t.text('body').notNullable()
      t.string('body_hash', 64).notNullable()
      t.string('note', 500).notNullable()
      t.dateTime('created_at').notNullable().defaultTo(utcNow(knex))
      t.uuid('created_by').nullable().references('id').inTable('nivaro_users')
      t.unique(['procedure_id', 'version'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_managed_procedure_versions')
  await knex.schema.dropTableIfExists('nivaro_managed_procedures')
}
