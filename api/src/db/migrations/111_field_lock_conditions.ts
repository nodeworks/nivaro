import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  const hasLock = await knex.schema.hasColumn('nivaro_layout_field_assignments', 'lock_conditions')
  if (!hasLock) {
    await knex.raw(`ALTER TABLE nivaro_layout_field_assignments ADD lock_conditions nvarchar(max) NULL`)
  }
  const hasRestore = await knex.schema.hasColumn('nivaro_layout_field_assignments', 'allow_revision_restore')
  if (!hasRestore) {
    await knex.raw(`ALTER TABLE nivaro_layout_field_assignments ADD allow_revision_restore bit NULL`)
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasLock = await knex.schema.hasColumn('nivaro_layout_field_assignments', 'lock_conditions')
  if (hasLock) await knex.schema.alterTable('nivaro_layout_field_assignments', (t) => { t.dropColumn('lock_conditions') })
  const hasRestore = await knex.schema.hasColumn('nivaro_layout_field_assignments', 'allow_revision_restore')
  if (hasRestore) await knex.schema.alterTable('nivaro_layout_field_assignments', (t) => { t.dropColumn('allow_revision_restore') })
}
