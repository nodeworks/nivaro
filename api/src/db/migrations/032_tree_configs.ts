import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_tree_configs', (t) => {
    t.increments('id')
    t.string('collection', 255).notNullable()
    t.string('parent_field', 255).notNullable().defaultTo('parent_id')
    t.string('label_field', 255).notNullable().defaultTo('name')
    t.string('order_field', 255).nullable()
    t.datetime('created_at').defaultTo(knex.fn.now())
    t.unique(['collection'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_tree_configs')
}
