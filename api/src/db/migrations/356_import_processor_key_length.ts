import type { Knex } from 'knex'

/**
 * `nivaro_import_definitions.processor` was 20 characters — enough for 'proc'
 * and 'service', not for a registered import processor's key
 * ('<extension>:<name>', see services/import-processors.ts).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_import_definitions'))) return
  if (!(await knex.schema.hasColumn('nivaro_import_definitions', 'processor'))) return
  await knex.schema.alterTable('nivaro_import_definitions', (t) => {
    t.string('processor', 120).nullable().alter()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_import_definitions'))) return
  if (!(await knex.schema.hasColumn('nivaro_import_definitions', 'processor'))) return
  // A key longer than 20 characters cannot survive the narrower column.
  const rows = (await knex('nivaro_import_definitions')
    .whereNotNull('processor')
    .select('id', 'processor')) as Array<{
    id: number
    processor: string
  }>
  const tooLong = rows.filter((r) => String(r.processor).length > 20).map((r) => r.id)
  if (tooLong.length)
    await knex('nivaro_import_definitions').whereIn('id', tooLong).update({ processor: null })
  await knex.schema.alterTable('nivaro_import_definitions', (t) => {
    t.string('processor', 20).nullable().alter()
  })
}
