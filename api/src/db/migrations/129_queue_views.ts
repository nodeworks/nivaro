import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_queue_views', (t) => {
    t.increments('id').primary()
    t.uuid('queue_id').notNullable().references('id').inTable('nivaro_queues').onDelete('CASCADE')
    t.string('name', 255).notNullable()
    // NO ACTION: nivaro_users/nivaro_roles already participate in other FK paths;
    // rows are cleaned up with the queue via queue_id's CASCADE.
    t.uuid('user').notNullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
    t.boolean('is_shared').notNullable().defaultTo(false)
    t.uuid('role').nullable().references('id').inTable('nivaro_roles').onDelete('NO ACTION')
    // JSON: { scope, filters, sort, group_by, view }
    t.specificType('state', 'nvarchar(max)').nullable()
    t.datetime('created_at').notNullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_queue_views')
}
