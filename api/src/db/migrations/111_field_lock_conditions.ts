import type { Knex } from 'knex'
import { isMssql } from '../dialect.js'
import { longText } from '../portable-ddl.js'

export async function up(knex: Knex): Promise<void> {
  const hasLock = await knex.schema.hasColumn('nivaro_layout_field_assignments', 'lock_conditions')
  if (!hasLock) {
    if (isMssql(knex))
      await knex.raw(
        `ALTER TABLE nivaro_layout_field_assignments ADD lock_conditions nvarchar(max) NULL`
      )
    else
      await knex.schema.alterTable('nivaro_layout_field_assignments', (t) => {
        longText(t, knex, 'lock_conditions').nullable()
      })
  }
  const hasRestore = await knex.schema.hasColumn(
    'nivaro_layout_field_assignments',
    'allow_revision_restore'
  )
  if (!hasRestore) {
    if (isMssql(knex))
      await knex.raw(
        `ALTER TABLE nivaro_layout_field_assignments ADD allow_revision_restore bit NULL`
      )
    else
      await knex.schema.alterTable('nivaro_layout_field_assignments', (t) => {
        t.boolean('allow_revision_restore').nullable()
      })
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasLock = await knex.schema.hasColumn('nivaro_layout_field_assignments', 'lock_conditions')
  if (hasLock)
    await knex.schema.alterTable('nivaro_layout_field_assignments', (t) => {
      t.dropColumn('lock_conditions')
    })
  const hasRestore = await knex.schema.hasColumn(
    'nivaro_layout_field_assignments',
    'allow_revision_restore'
  )
  if (hasRestore)
    await knex.schema.alterTable('nivaro_layout_field_assignments', (t) => {
      t.dropColumn('allow_revision_restore')
    })
}
