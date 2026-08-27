import type { Knex } from 'knex'

/**
 * Cascading matrix filters — an owner dimension may declare cascade rules
 * (JSON array of {parent_field, filter, via_many?}) narrowing its option list
 * by sibling dimensions' picked values, the same rule shape record-form
 * cascade_filters use. Example: the Project dimension filters by the chosen
 * Zone (divisions junction, via_many) and Project Type (plain FK).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_pipeline_owner_dimensions', 'cascade'))) {
    await knex.schema.alterTable('nivaro_pipeline_owner_dimensions', (t) => {
      t.text('cascade').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_pipeline_owner_dimensions', 'cascade')) {
    await knex.schema.alterTable('nivaro_pipeline_owner_dimensions', (t) => {
      t.dropColumn('cascade')
    })
  }
}
