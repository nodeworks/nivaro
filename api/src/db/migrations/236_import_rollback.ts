import type { Knex } from 'knex'

/** Import rollback: per-run capture of what was created/overwritten. */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_import_jobs', 'rollback_data'))) {
    await knex.schema.alterTable('nivaro_import_jobs', (t) => {
      /** JSON {created: [{id}], updated: [{key_field, key, prior}]} */
      t.text('rollback_data').nullable()
      t.dateTime('rolled_back_at').nullable()
      t.uuid('rolled_back_by').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_import_jobs', 'rollback_data')) {
    await knex.schema.alterTable('nivaro_import_jobs', (t) => {
      t.dropColumn('rollback_data')
      t.dropColumn('rolled_back_at')
      t.dropColumn('rolled_back_by')
    })
  }
}
