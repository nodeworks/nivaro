import type { Knex } from 'knex'
import { isMssql } from '../dialect.js'

export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_layout_field_assignments', 'show_approval_chain')
  if (!has) {
    if (isMssql(knex))
      await knex.raw(
        `ALTER TABLE nivaro_layout_field_assignments ADD show_approval_chain bit NOT NULL DEFAULT 0`
      )
    else
      await knex.schema.alterTable('nivaro_layout_field_assignments', (t) => {
        t.boolean('show_approval_chain').notNullable().defaultTo(false)
      })
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_layout_field_assignments', 'show_approval_chain')
  if (has) {
    await knex.schema.alterTable('nivaro_layout_field_assignments', (t) => {
      t.dropColumn('show_approval_chain')
    })
  }
}
