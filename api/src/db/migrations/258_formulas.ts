import type { Knex } from 'knex'

/**
 * Formulas sprint: named instance constants (#244) + fiscal calendar config
 * (#343) on the settings singleton.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'formula_constants'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('formula_constants').nullable() // JSON {NAME: number}
      t.integer('fiscal_year_start_month').nullable() // 1-12; null = January
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.dropColumn('formula_constants')
    t.dropColumn('fiscal_year_start_month')
  })
}
