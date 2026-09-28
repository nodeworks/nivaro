import type { Knex } from 'knex'

/**
 * Deprecation policy for the GraphQL schema (#613): a field marked deprecated
 * carries `@deprecated` in the schema from `deprecated_at`, and may be removed
 * only once `nivaro_settings.graphql_deprecation_days` have passed (blank =
 * 14, 0 = no policy). Additive; both columns nullable.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_fields', 'deprecated_at'))) {
    await knex.schema.alterTable('nivaro_fields', (t) => {
      t.datetime('deprecated_at').nullable()
      t.string('deprecation_note', 500).nullable()
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_settings', 'graphql_deprecation_days'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.integer('graphql_deprecation_days').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_fields', 'deprecated_at')) {
    await knex.schema.alterTable('nivaro_fields', (t) => {
      t.dropColumn('deprecated_at')
      t.dropColumn('deprecation_note')
    })
  }
  if (await knex.schema.hasColumn('nivaro_settings', 'graphql_deprecation_days')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('graphql_deprecation_days')
    })
  }
}
