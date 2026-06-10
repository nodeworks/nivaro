import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_attribute_definitions', (t) => {
    t.increments('id')
    t.string('collection', 255).notNullable()
    t.string('key', 255).notNullable() // slug, e.g. "priority_score"
    t.string('label', 255).notNullable() // display name
    t.string('type', 50).notNullable().defaultTo('text') // text, number, boolean, date, select
    t.specificType('options', 'nvarchar(max)').nullable() // JSON array of strings for 'select' type
    t.boolean('required').notNullable().defaultTo(false)
    t.integer('sort').notNullable().defaultTo(0)
    t.boolean('is_active').notNullable().defaultTo(true)
    // nivaro_users.id is a uuid; existing FKs all use uuid + NO ACTION (MSSQL multi-cascade rules)
    t.uuid('created_by').nullable()
    t.foreign('created_by')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.datetime('created_at').defaultTo(knex.fn.now())
  })

  // Unique: one definition per collection+key ([key] is reserved in MSSQL)
  await knex.raw(`
    ALTER TABLE nivaro_attribute_definitions
    ADD CONSTRAINT uq_attr_def_col_key UNIQUE (collection, [key])
  `)

  await knex.schema.createTable('nivaro_attribute_values', (t) => {
    t.increments('id')
    t.string('collection', 255).notNullable()
    t.string('item_id', 255).notNullable() // varchar to support both UUID and integer PKs
    t.string('attribute_key', 255).notNullable()
    t.specificType('value', 'nvarchar(max)').nullable() // all types stored as text
    t.datetime('updated_at').defaultTo(knex.fn.now())
  })

  await knex.raw(`
    ALTER TABLE nivaro_attribute_values
    ADD CONSTRAINT uq_attr_val UNIQUE (collection, item_id, attribute_key)
  `)
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_attribute_values')
  await knex.schema.dropTableIfExists('nivaro_attribute_definitions')
}
