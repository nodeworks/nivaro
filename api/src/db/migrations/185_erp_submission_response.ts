import type { Knex } from 'knex'

// Response body per ERP submission attempt — lets the form banner show the
// raw request/response pair for debugging failed MDSi/Fusion pushes.
export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_erp_submissions', 'response')
  if (!has) {
    await knex.schema.alterTable('nivaro_erp_submissions', (t) => {
      t.text('response').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_erp_submissions', 'response')
  if (has) {
    await knex.schema.alterTable('nivaro_erp_submissions', (t) => {
      t.dropColumn('response')
    })
  }
}
