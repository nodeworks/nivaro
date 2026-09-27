import type { Knex } from 'knex'

/**
 * The request log kept the path and dropped the query string, so a replayed
 * request lost its parameters (`?return=ids`, `?atomic=1`, a mapping's
 * `?dry_run=1`). Values under credential-looking names are masked before they
 * are stored.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_api_logs'))) return
  if (await knex.schema.hasColumn('nivaro_api_logs', 'query')) return
  await knex.schema.alterTable('nivaro_api_logs', (t) => {
    t.string('query', 500).nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_api_logs'))) return
  if (!(await knex.schema.hasColumn('nivaro_api_logs', 'query'))) return
  await knex.schema.alterTable('nivaro_api_logs', (t) => {
    t.dropColumn('query')
  })
}
