import type { Knex } from 'knex'

/**
 * #635 — dashboard-level global filter bar. One JSON column: the saved
 * filter definitions (`WidgetFilter[]`) applied across every widget whose
 * collection carries the field. Guarded + additive per migration convention.
 */
export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_dashboards', 'global_filters')
  if (!has) {
    await knex.schema.alterTable('nivaro_dashboards', (t) => {
      t.text('global_filters').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_dashboards', 'global_filters')
  if (has) {
    await knex.schema.alterTable('nivaro_dashboards', (t) => {
      t.dropColumn('global_filters')
    })
  }
}
