import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_field_translations', (t) => {
    t.increments('id')
    t.string('collection', 255).notNullable()
    t.string('item_id', 255).notNullable()
    t.string('field', 255).notNullable()
    t.string('locale', 20).notNullable()
    t.specificType('value', 'nvarchar(max)').nullable()
    t.datetime('updated_at').defaultTo(knex.fn.now())
  })

  await knex.raw(`
    ALTER TABLE nivaro_field_translations
    ADD CONSTRAINT uq_field_translation UNIQUE (collection, item_id, field, locale)
  `)
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_field_translations')
}
