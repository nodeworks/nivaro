import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_field_rules', (t) => {
    t.increments('id')
    t.string('collection', 255).notNullable()
    t.string('trigger_field', 255).notNullable()
    t.string('trigger_op', 50).notNullable().defaultTo('eq') // eq, neq, null, nnull, in, contains
    t.text('trigger_value').nullable() // string for eq/neq/contains, JSON array for 'in', null for null/nnull
    t.string('target_field', 255).notNullable()
    t.string('target_type', 50).notNullable().defaultTo('set') // set, clear
    t.text('target_value').nullable() // literal value to set (null for 'clear')
    t.integer('sort').notNullable().defaultTo(0)
    t.boolean('is_active').notNullable().defaultTo(true)
    t.uuid('created_by').nullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
    t.datetime('created_at').defaultTo(knex.fn.now())
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_field_rules')
}
