import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_field_groups', 'swap_config')
  if (!has) {
    await knex.raw(`ALTER TABLE nivaro_field_groups ADD swap_config nvarchar(max) NULL`)
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_field_groups', 'swap_config')
  if (has) {
    await knex.schema.alterTable('nivaro_field_groups', (t) => { t.dropColumn('swap_config') })
  }
}
