import type { Knex } from 'knex'
import { isMssql } from '../dialect.js'
import { longText } from '../portable-ddl.js'

export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_field_groups', 'swap_config')
  if (!has) {
    if (isMssql(knex))
      await knex.raw(`ALTER TABLE nivaro_field_groups ADD swap_config nvarchar(max) NULL`)
    else
      await knex.schema.alterTable('nivaro_field_groups', (t) => {
        longText(t, knex, 'swap_config').nullable()
      })
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_field_groups', 'swap_config')
  if (has) {
    await knex.schema.alterTable('nivaro_field_groups', (t) => {
      t.dropColumn('swap_config')
    })
  }
}
