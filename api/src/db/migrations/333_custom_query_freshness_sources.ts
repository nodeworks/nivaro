import type { Knex } from 'knex'

/**
 * nivaro_custom_queries.freshness_sources — which tables' newest write says
 * whether a cached figure is stale in BUSINESS terms.
 *
 * A cache stamp reading "Updated 3m ago" answers the wrong question for a
 * budget number: what matters is whether an invoice has landed since. The
 * column is a JSON list `[{"table": "invoices", "column": "changed"}]`; NULL
 * means infer it from the SQL (tables named after FROM / JOIN, or inside the
 * procedure an EXEC names, that carry a timestamp column).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_custom_queries', 'freshness_sources'))) {
    await knex.schema.alterTable('nivaro_custom_queries', (t) => {
      t.text('freshness_sources').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_custom_queries', 'freshness_sources')) {
    await knex.schema.alterTable('nivaro_custom_queries', (t) => {
      t.dropColumn('freshness_sources')
    })
  }
}
