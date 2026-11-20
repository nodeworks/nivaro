import type { Knex } from 'knex'
import { isMssql } from '../dialect.js'

export async function up(knex: Knex): Promise<void> {
  // Patch: migration 099 may have partially applied; ensure all 3 columns exist.
  const existing = new Set<string>()
  if (isMssql(knex)) {
    const colCheck = await knex.raw(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'nivaro_field_groups'
    AND COLUMN_NAME IN ('hide_when_empty', 'visibility_mode', 'summary_fields')
  `)
    for (const r of colCheck as any[]) existing.add(r.COLUMN_NAME)
  } else {
    for (const c of ['hide_when_empty', 'visibility_mode', 'summary_fields'])
      if (await knex.schema.hasColumn('nivaro_field_groups', c)) existing.add(c)
  }
  if (!existing.has('hide_when_empty')) {
    if (isMssql(knex))
      await knex.raw(`ALTER TABLE nivaro_field_groups ADD hide_when_empty bit NOT NULL DEFAULT 0`)
    else
      await knex.schema.alterTable('nivaro_field_groups', (t) => {
        t.boolean('hide_when_empty').notNullable().defaultTo(false)
      })
  }
  if (!existing.has('visibility_mode')) {
    if (isMssql(knex))
      await knex.raw(
        `ALTER TABLE nivaro_field_groups ADD visibility_mode varchar(20) NOT NULL DEFAULT 'always'`
      )
    else
      await knex.schema.alterTable('nivaro_field_groups', (t) => {
        t.string('visibility_mode', 20).notNullable().defaultTo('always')
      })
  }
  if (!existing.has('summary_fields')) {
    if (isMssql(knex))
      await knex.raw(`ALTER TABLE nivaro_field_groups ADD summary_fields varchar(500) NULL`)
    else
      await knex.schema.alterTable('nivaro_field_groups', (t) => {
        t.string('summary_fields', 500).nullable()
      })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE nivaro_field_groups DROP COLUMN summary_fields`).catch(() => {})
  await knex.raw(`ALTER TABLE nivaro_field_groups DROP COLUMN visibility_mode`).catch(() => {})
  await knex.raw(`ALTER TABLE nivaro_field_groups DROP COLUMN hide_when_empty`).catch(() => {})
}
