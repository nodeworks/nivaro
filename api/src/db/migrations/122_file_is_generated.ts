import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_files', (t) => {
    t.boolean('is_generated').notNullable().defaultTo(false)
    t.integer('source_template_id').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_files', (t) => {
    t.dropColumn('is_generated')
    t.dropColumn('source_template_id')
  })
}
