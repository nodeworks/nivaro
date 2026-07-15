import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_import_templates', (t) => {
    t.uuid('id').primary()
    t.string('name', 255).notNullable()
    t.string('collection', 255).notNullable()
    t.string('mode', 20).notNullable().defaultTo('prefill') // prefill | direct | both
    t.text('file_types').nullable() // JSON string[]
    t.string('sheet_match', 255).nullable()
    t.integer('header_row').notNullable().defaultTo(1)
    t.text('header_map').nullable() // JSON ImportHeaderRule[]
    t.text('line_map').nullable() // JSON ImportLineConfig
    t.string('attach_file_field', 255).nullable()
    t.boolean('is_active').notNullable().defaultTo(true)
    t.boolean('is_shared').notNullable().defaultTo(false)
    t.uuid('role_id').nullable().references('id').inTable('nivaro_roles').onDelete('NO ACTION')
    t.uuid('created_by').nullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now())
    t.dateTime('updated_at').notNullable().defaultTo(knex.fn.now())
    t.index(['collection'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_import_templates')
}
