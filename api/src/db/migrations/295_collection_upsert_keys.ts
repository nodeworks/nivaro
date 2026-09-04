import type { Knex } from 'knex'

/**
 * Per-collection upsert keys — JSON array of column names that identify a
 * record (e.g. ["workflow","year"] on forecasts). When a create carries every
 * key and a row already matches, the items service routes the write to an
 * update of that row instead of inserting a duplicate. This is how a
 * collection whose identity is a natural key stays one-row-per-key no matter
 * which client writes (form grid, API, GraphQL integrations).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_collections', 'upsert_keys'))) {
    await knex.schema.alterTable('nivaro_collections', (t) => {
      t.text('upsert_keys').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_collections', 'upsert_keys')) {
    await knex.schema.alterTable('nivaro_collections', (t) => {
      t.dropColumn('upsert_keys')
    })
  }
}
