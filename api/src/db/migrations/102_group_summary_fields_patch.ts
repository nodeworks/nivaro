import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  // Patch: migration 099 may have partially applied; ensure all 3 columns exist.
  const colCheck = await knex.raw(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'nivaro_field_groups'
    AND COLUMN_NAME IN ('hide_when_empty', 'visibility_mode', 'summary_fields')
  `)
  const existing = new Set((colCheck as any[]).map((r: any) => r.COLUMN_NAME))
  if (!existing.has('hide_when_empty')) {
    await knex.raw(`ALTER TABLE nivaro_field_groups ADD hide_when_empty bit NOT NULL DEFAULT 0`)
  }
  if (!existing.has('visibility_mode')) {
    await knex.raw(`ALTER TABLE nivaro_field_groups ADD visibility_mode varchar(20) NOT NULL DEFAULT 'always'`)
  }
  if (!existing.has('summary_fields')) {
    await knex.raw(`ALTER TABLE nivaro_field_groups ADD summary_fields varchar(500) NULL`)
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE nivaro_field_groups DROP COLUMN summary_fields`).catch(() => {})
  await knex.raw(`ALTER TABLE nivaro_field_groups DROP COLUMN visibility_mode`).catch(() => {})
  await knex.raw(`ALTER TABLE nivaro_field_groups DROP COLUMN hide_when_empty`).catch(() => {})
}
