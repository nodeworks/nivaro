import type { Knex } from 'knex'

/**
 * User Scopes for custom queries.
 *
 * Custom queries are raw SQL, so the items-service scope enforcement never
 * touches them — a restrict-mode user saw the whole company through any
 * report proc, which has been the documented "raw-SQL gap" since scopes
 * shipped. `scope_params` declares, per query, which execute-params carry a
 * scoped dimension:
 *
 *   { "Zones": { "dimension": "divisions", "translate": "display" },
 *     "Regions": { "dimension": "region", "translate": "id" } }
 *
 * At execute time the route intersects the caller's value with their
 * restrict-mode allowance (or injects the full allowance when the param was
 * omitted). Opt-in per query — nothing changes until a query declares its
 * contract, because injecting into a proc that doesn't expect it would
 * silently change results.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_custom_queries', 'scope_params')) return
  await knex.schema.alterTable('nivaro_custom_queries', (t) => {
    t.text('scope_params').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_custom_queries', 'scope_params'))) return
  await knex.schema.alterTable('nivaro_custom_queries', (t) => t.dropColumn('scope_params'))
}
