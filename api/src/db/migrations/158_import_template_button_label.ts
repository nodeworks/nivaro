import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_import_templates', (t) => {
    t.string('button_label', 100).nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_import_templates', (t) => {
    t.dropColumn('button_label')
  })
}
