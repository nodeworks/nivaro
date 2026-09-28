import type { Knex } from 'knex'

/**
 * GraphQL operation analytics (#607): the request log knew only that a call
 * hit /graphql. Each GraphQL request now records the operation it ran, its
 * kind, the measured cost, how many errors the 200 answer carried, and which
 * @deprecated fields it selected — the per-operation view a REST path gives
 * for free. Additive, all nullable.
 */
const COLS = [
  'graphql_operation',
  'graphql_kind',
  'graphql_depth',
  'graphql_selections',
  'graphql_errors',
  'graphql_deprecated'
]

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_api_logs'))) return
  if (await knex.schema.hasColumn('nivaro_api_logs', 'graphql_operation')) return
  await knex.schema.alterTable('nivaro_api_logs', (t) => {
    t.string('graphql_operation', 200).nullable()
    t.string('graphql_kind', 20).nullable()
    t.integer('graphql_depth').nullable()
    t.integer('graphql_selections').nullable()
    t.integer('graphql_errors').nullable()
    t.string('graphql_deprecated', 500).nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_api_logs'))) return
  if (!(await knex.schema.hasColumn('nivaro_api_logs', 'graphql_operation'))) return
  await knex.schema.alterTable('nivaro_api_logs', (t) => {
    for (const c of COLS) t.dropColumn(c)
  })
}
