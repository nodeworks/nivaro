import type { Knex } from 'knex'

/**
 * One row per name, one number per row. A process that writes configuration
 * moves the number; every other process on this database polls it and clears
 * its in-process caches when it moved (db/config-epoch.ts). Runtime
 * bookkeeping, never promoted between environments.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_cache_epochs')) return
  await knex.schema.createTable('nivaro_cache_epochs', (t) => {
    t.string('name', 80).notNullable().primary()
    t.bigInteger('epoch').notNullable().defaultTo(0)
    t.datetime('updated_at').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_cache_epochs')
}
