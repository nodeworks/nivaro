import type { Knex } from 'knex'

/**
 * API & SDK sprint: sandbox keys (#166), per-key GraphQL caps (#162),
 * query-as-endpoint (#340), GraphQL schema changelog (#163), REST route
 * changelog (#315).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_api_keys', 'sandbox'))) {
    await knex.schema.alterTable('nivaro_api_keys', (t) => {
      t.boolean('sandbox').notNullable().defaultTo(false)
      t.integer('graphql_max_depth').nullable()
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_custom_queries', 'public_token'))) {
    await knex.schema.alterTable('nivaro_custom_queries', (t) => {
      t.string('public_token', 64).nullable()
    })
  }
  if (!(await knex.schema.hasTable('nivaro_graphql_schema_log'))) {
    await knex.schema.createTable('nivaro_graphql_schema_log', (t) => {
      t.increments('id')
      t.datetime('at').notNullable()
      t.text('snapshot').notNullable() // {types: {name: [fields]}}
      t.text('diff').nullable() // human summary of changes vs previous
      t.boolean('breaking').notNullable().defaultTo(false)
    })
  }
  if (!(await knex.schema.hasTable('nivaro_api_changelog'))) {
    await knex.schema.createTable('nivaro_api_changelog', (t) => {
      t.increments('id')
      t.string('version', 50).notNullable()
      t.datetime('at').notNullable()
      t.text('routes').notNullable() // ["GET /api/items/:collection", ...]
      t.text('diff').nullable()
      t.boolean('breaking').notNullable().defaultTo(false)
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_api_keys', (t) => {
    t.dropColumn('sandbox')
    t.dropColumn('graphql_max_depth')
  })
  await knex.schema.alterTable('nivaro_custom_queries', (t) => {
    t.dropColumn('public_token')
  })
  await knex.schema.dropTableIfExists('nivaro_graphql_schema_log')
  await knex.schema.dropTableIfExists('nivaro_api_changelog')
}
