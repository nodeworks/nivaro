import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_line_items', (t) => {
    t.increments('id')
    t.string('parent_collection', 255).notNullable()
    t.string('parent_id', 255).notNullable()
    t.string('line_item_field', 255).notNullable()
    t.integer('sort').notNullable().defaultTo(0)
    t.specificType('data', 'nvarchar(max)').notNullable()
    t.datetime('created_at').defaultTo(knex.fn.now())
    t.datetime('updated_at').defaultTo(knex.fn.now())
  })

  await knex.schema.createTable('nivaro_line_item_templates', (t) => {
    t.increments('id')
    t.string('collection', 255).notNullable()
    t.string('field', 255).notNullable()
    t.string('name', 255).notNullable()
    t.specificType('items', 'nvarchar(max)').notNullable()
    t.uuid('created_by').nullable()
    t.foreign('created_by')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.datetime('created_at').defaultTo(knex.fn.now())
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_line_item_templates')
  await knex.schema.dropTableIfExists('nivaro_line_items')
}
