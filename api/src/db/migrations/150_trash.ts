import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_trash', (t) => {
    t.increments('id').primary()
    t.string('collection', 255).notNullable()
    t.string('item_id', 255).notNullable()
    t.text('data', 'longtext').notNullable()
    t.uuid('deleted_by').nullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
    t.dateTime('deleted_at').notNullable().defaultTo(knex.fn.now())
    t.index(['collection'])
    t.index(['deleted_at'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_trash')
}
