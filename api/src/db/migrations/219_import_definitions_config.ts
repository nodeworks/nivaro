import type { Knex } from 'knex'

/**
 * Config-managed staged imports: the definition row grows a declared staging
 * schema, an optional app-managed procedure body, and a pre-flight validation
 * config — plus a versions table so all three snapshot and restore together.
 *
 * Everything is additive and nullable: a definition with none of it behaves
 * exactly as before (staging schema derived from the file, procedure managed
 * outside the app, no pre-flight validation).
 */
export async function up(knex: Knex): Promise<void> {
  const addCol = async (name: string, add: (t: Knex.AlterTableBuilder) => void) => {
    if (!(await knex.schema.hasColumn('nivaro_import_definitions', name))) {
      await knex.schema.alterTable('nivaro_import_definitions', add)
    }
  }
  await addCol('staging_columns', (t) => {
    t.text('staging_columns').nullable()
  })
  await addCol('procedure_body', (t) => {
    t.text('procedure_body', 'longtext').nullable()
  })
  await addCol('procedure_hash', (t) => {
    t.string('procedure_hash', 64).nullable()
  })
  await addCol('procedure_deployed_at', (t) => {
    t.dateTime('procedure_deployed_at').nullable()
  })
  await addCol('validation', (t) => {
    t.text('validation').nullable()
  })

  if (!(await knex.schema.hasTable('nivaro_import_definition_versions'))) {
    await knex.schema.createTable('nivaro_import_definition_versions', (t) => {
      t.increments('id')
      t.integer('definition')
        .notNullable()
        .references('id')
        .inTable('nivaro_import_definitions')
        .onDelete('CASCADE')
        .onUpdate('NO ACTION')
      t.integer('version').notNullable()
      t.text('snapshot', 'longtext').notNullable()
      t.string('note', 255).nullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').defaultTo(knex.fn.now())
      t.unique(['definition', 'version'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_import_definition_versions')
  for (const col of [
    'staging_columns',
    'procedure_body',
    'procedure_hash',
    'procedure_deployed_at',
    'validation'
  ]) {
    if (await knex.schema.hasColumn('nivaro_import_definitions', col)) {
      await knex.schema.alterTable('nivaro_import_definitions', (t) => {
        t.dropColumn(col)
      })
    }
  }
}
