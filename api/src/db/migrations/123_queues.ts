import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_queues', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid())
    t.string('name', 255).notNullable()
    t.string('description', 500).nullable()
    t.string('icon', 50).nullable()
    t.string('color', 20).nullable()
    t.uuid('owner').notNullable().references('id').inTable('nivaro_users')
    t.boolean('is_shared').notNullable().defaultTo(false)
    t.uuid('role_id').nullable().references('id').inTable('nivaro_roles')
    t.string('view_mode', 10).notNullable().defaultTo('table')
    t.boolean('is_active').notNullable().defaultTo(true)
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now())
    t.datetime('updated_at').nullable()
  })

  await knex.schema.createTable('nivaro_queue_sources', (t) => {
    t.increments('id').primary()
    t.uuid('queue_id').notNullable().references('id').inTable('nivaro_queues').onDelete('CASCADE')
    t.string('type', 20).notNullable()
    t.string('collection', 255).nullable()
    t.specificType('filters', 'nvarchar(max)').nullable()
    t.specificType('state_values', 'nvarchar(max)').nullable()
    t.integer('sort').notNullable().defaultTo(0)
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_queue_sources')
  await knex.schema.dropTableIfExists('nivaro_queues')
}
