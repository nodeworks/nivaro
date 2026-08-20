import type { Knex } from 'knex'

/**
 * Staged imports gain a second processor mode. `processor` = 'proc' (default,
 * null) keeps the staging-table + stored-procedure path; 'service' routes the
 * parsed rows through the items service instead (createOne/updateOne after a
 * diff against existing rows), so imports produce revisions, activity, field
 * rules, validation and computed fields like any other write. `service_config`
 * holds the JSON mapping (see staged-import-service.ts).
 */
export async function up(knex: Knex): Promise<void> {
  const addCol = async (name: string, add: (t: Knex.AlterTableBuilder) => void) => {
    if (!(await knex.schema.hasColumn('nivaro_import_definitions', name))) {
      await knex.schema.alterTable('nivaro_import_definitions', add)
    }
  }
  await addCol('processor', (t) => {
    t.string('processor', 20).nullable()
  })
  await addCol('service_config', (t) => {
    t.text('service_config').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  for (const col of ['processor', 'service_config']) {
    if (await knex.schema.hasColumn('nivaro_import_definitions', col)) {
      await knex.schema.alterTable('nivaro_import_definitions', (t) => {
        t.dropColumn(col)
      })
    }
  }
}
