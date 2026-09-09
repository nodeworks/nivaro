import type { Knex } from 'knex'

/**
 * Per-definition post-run receipt (backlog #25): after a run, each affected
 * record's owners get ONE message summarising what the import did for it.
 * JSON `{ enabled: false }` by default — nothing sends until switched on.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_import_definitions'))) return
  if (!(await knex.schema.hasColumn('nivaro_import_definitions', 'receipt'))) {
    await knex.schema.alterTable('nivaro_import_definitions', (t) => {
      t.text('receipt').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_import_definitions'))) return
  if (await knex.schema.hasColumn('nivaro_import_definitions', 'receipt')) {
    await knex.schema.alterTable('nivaro_import_definitions', (t) => {
      t.dropColumn('receipt')
    })
  }
}
