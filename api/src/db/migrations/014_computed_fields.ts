import type { Knex } from 'knex'

export async function up(knex: Knex) {
  // Step 1: add computed_formula and computed_type as nullable; add computed_store as nullable
  // (MSSQL rejects adding a NOT NULL column to a populated table in one step)
  await knex.schema.alterTable('nivaro_fields', (t) => {
    t.specificType('computed_formula', 'nvarchar(max)').nullable().defaultTo(null)
    t.string('computed_type', 10).nullable().defaultTo(null)
    t.boolean('computed_store').nullable().defaultTo(false)
  })

  // Step 2: backfill any existing rows so no nulls remain
  await knex('nivaro_fields').whereNull('computed_store').update({ computed_store: false })

  // Step 3: alter computed_store to NOT NULL now that every row has a value
  await knex.schema.alterTable('nivaro_fields', (t) => {
    t.boolean('computed_store').notNullable().defaultTo(false).alter()
  })
}

export async function down(knex: Knex) {
  await knex.schema.alterTable('nivaro_fields', (t) => {
    t.dropColumn('computed_formula')
    t.dropColumn('computed_type')
    t.dropColumn('computed_store')
  })
}
