import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  // Relations that point to the legacy Directus internal table name
  // should use the Nivaro users collection instead.
  await knex('nivaro_relations')
    .where({ one_collection: 'directus_users' })
    .update({ one_collection: 'nivaro_users' })

  await knex('nivaro_relations')
    .where({ many_collection: 'directus_users' })
    .update({ many_collection: 'nivaro_users' })
}

export async function down(knex: Knex): Promise<void> {
  await knex('nivaro_relations')
    .where({ one_collection: 'nivaro_users' })
    .update({ one_collection: 'directus_users' })

  await knex('nivaro_relations')
    .where({ many_collection: 'nivaro_users' })
    .update({ many_collection: 'directus_users' })
}
