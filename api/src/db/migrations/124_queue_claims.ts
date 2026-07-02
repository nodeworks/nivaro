import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_queue_claims', (t) => {
    t.increments('id').primary()
    t.uuid('queue_id').notNullable().references('id').inTable('nivaro_queues').onDelete('CASCADE')
    t.string('source_collection', 255).notNullable()
    t.string('item_id', 255).notNullable()
    t.uuid('claimed_by').notNullable().references('id').inTable('nivaro_users')
    t.datetime('claimed_at').notNullable().defaultTo(knex.raw('getutcdate()'))
    t.unique(['queue_id', 'source_collection', 'item_id'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_queue_claims')
}
