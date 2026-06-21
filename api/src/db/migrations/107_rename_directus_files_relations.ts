import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex('nivaro_relations')
    .where('one_collection', 'directus_files')
    .update({ one_collection: 'nivaro_files' })

  await knex('nivaro_relations')
    .where('many_collection', 'directus_files')
    .update({ many_collection: 'nivaro_files' })
}

export async function down(knex: Knex): Promise<void> {
  // not reversible — directus_files no longer exists
}
