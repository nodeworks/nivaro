import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_picker_exclusions', t => {
    t.increments('id').primary()
    t.string('collection', 255).notNullable()
    t.string('item_id', 255).notNullable()
    t.timestamp('created_at').defaultTo(knex.fn.now())
    t.uuid('created_by').nullable()
      .references('id').inTable('nivaro_users').onDelete('SET NULL').onUpdate('NO ACTION')
    t.unique(['collection', 'item_id'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_picker_exclusions')
}
