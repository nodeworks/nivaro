import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_import_templates', (t) => {
    t.text('reimport').nullable() // JSON ImportReimportConfig | null
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_import_templates', (t) => {
    t.dropColumn('reimport')
  })
}
