import type { Knex } from 'knex'

/**
 * nivaro_extension_registry_versions (#530).
 *
 * Extensions register hooks, crons, flow ops, mail types, readiness and
 * integrity checks, bulk actions, digest sections… at boot, and nothing
 * recorded what a given BUILD registered — "when did this check appear?" had
 * no answer. After every load the ledger for each extension is fingerprinted;
 * a new fingerprint becomes a new version row, a repeat bumps last_seen_at.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_extension_registry_versions'))) {
    await knex.schema.createTable('nivaro_extension_registry_versions', (t) => {
      t.increments('id').primary()
      t.string('extension', 120).notNullable()
      t.integer('version').notNullable()
      t.string('fingerprint', 64).notNullable()
      t.text('ledger').notNullable() // JSON — see services/extension-registry-versions.ts
      t.string('app_version', 40).nullable()
      t.dateTime('first_seen_at').notNullable()
      t.dateTime('last_seen_at').notNullable()
      t.integer('boots').notNullable().defaultTo(1)
      t.unique(['extension', 'version'], { indexName: 'uq_ext_registry_version' })
      t.index(['extension', 'last_seen_at'], 'ix_ext_registry_seen')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_extension_registry_versions'))
    await knex.schema.dropTable('nivaro_extension_registry_versions')
}
