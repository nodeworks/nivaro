import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_fields', 'placeholder')
  if (!has) {
    await knex.schema.alterTable('nivaro_fields', (t) => {
      t.string('placeholder', 500).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_fields', (t) => {
    t.dropColumn('placeholder')
  })
}
