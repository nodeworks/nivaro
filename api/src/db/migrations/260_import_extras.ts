import type { Knex } from 'knex'

// Imports & Exports sprint: per-column cleanup transforms on CSV import jobs
// (#212) — JSON Record<csvColumn, transform name>.
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_import_jobs', 'transforms'))) {
    await knex.schema.alterTable('nivaro_import_jobs', (t) => {
      t.text('transforms').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_import_jobs', 'transforms')) {
    await knex.schema.alterTable('nivaro_import_jobs', (t) => t.dropColumn('transforms'))
  }
}
