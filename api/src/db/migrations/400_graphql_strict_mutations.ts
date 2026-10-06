import type { Knex } from 'knex'

/**
 * Honest GraphQL mutations on a missing id (#1222).
 *
 * `update_<c>_item` / `delete_<c>_item` on an id that does not exist used to
 * answer 200 with null data. With `nivaro_settings.graphql_strict_mutations`
 * on they answer a NOT_FOUND GraphQL error instead (status 404 in the
 * extensions). Off by default so a partner can be told before it changes.
 */
const TABLE = 'nivaro_settings'
const COLUMN = 'graphql_strict_mutations'

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (await knex.schema.hasColumn(TABLE, COLUMN)) return
  await knex.schema.alterTable(TABLE, (t) => {
    t.boolean(COLUMN).notNullable().defaultTo(false)
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) return
  await knex.schema.alterTable(TABLE, (t) => {
    t.dropColumn(COLUMN)
  })
}
