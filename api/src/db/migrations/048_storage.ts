import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_files', (t) => {
    t.datetime('expires_at').nullable()
  })
  await knex.schema.alterTable('nivaro_files', (t) => {
    t.string('storage_provider', 20).notNullable().defaultTo('local')
  })

  await knex.schema.createTable('nivaro_pdf_templates', (t) => {
    t.increments('id')
    t.string('name', 255).notNullable()
    t.string('collection', 100).nullable()
    t.specificType('template', 'nvarchar(max)').notNullable()
    t.uuid('created_by').notNullable()
    t.foreign('created_by')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.datetime('created_at').defaultTo(knex.fn.now())
    t.datetime('updated_at').defaultTo(knex.fn.now())
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_pdf_templates')
  await knex.schema.alterTable('nivaro_files', (t) => {
    t.dropColumn('storage_provider')
  })
  await knex.schema.alterTable('nivaro_files', (t) => {
    t.dropColumn('expires_at')
  })
}
