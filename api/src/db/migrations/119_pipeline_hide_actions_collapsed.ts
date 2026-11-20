import type { Knex } from 'knex'
import { isMssql } from '../dialect.js'

export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn(
    'nivaro_layout_field_assignments',
    'hide_actions_when_collapsed'
  )
  if (!has) {
    if (isMssql(knex))
      await knex.raw(
        `ALTER TABLE nivaro_layout_field_assignments ADD hide_actions_when_collapsed bit NOT NULL DEFAULT 0`
      )
    else
      await knex.schema.alterTable('nivaro_layout_field_assignments', (t) => {
        t.boolean('hide_actions_when_collapsed').notNullable().defaultTo(false)
      })
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn(
    'nivaro_layout_field_assignments',
    'hide_actions_when_collapsed'
  )
  if (has) {
    await knex.schema.alterTable('nivaro_layout_field_assignments', (t) => {
      t.dropColumn('hide_actions_when_collapsed')
    })
  }
}
