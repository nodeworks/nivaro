import type { Knex } from 'knex'

/**
 * Let a collection be addressed in a URL by something people recognise.
 *
 * `url_alias_fields` is a JSON array of column names — one for the simple case
 * ("workflow_id"), several when no single column identifies a record on its
 * own, in which case the URL segment is their values joined by `-`.
 *
 * Stored as JSON rather than a single column name so the multi-field case does
 * not need a second migration later, and parsed with the same parseJson
 * treatment as every other JSON text column here.
 */
export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_collections', 'url_alias_fields')
  if (has) return
  await knex.schema.alterTable('nivaro_collections', (t) => {
    t.text('url_alias_fields').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_collections', 'url_alias_fields')
  if (!has) return
  await knex.schema.alterTable('nivaro_collections', (t) => {
    t.dropColumn('url_alias_fields')
  })
}
