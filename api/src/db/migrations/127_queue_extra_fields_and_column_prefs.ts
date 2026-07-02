import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queue_sources', (t) => {
    t.specificType('extra_fields', 'nvarchar(max)').nullable()
  })

  await knex.schema.createTable('nivaro_queue_column_prefs', (t) => {
    t.increments('id').primary()
    t.uuid('queue_id').notNullable().references('id').inTable('nivaro_queues').onDelete('CASCADE')
    t.uuid('user').notNullable().references('id').inTable('nivaro_users')
    t.specificType('visible_columns', 'nvarchar(max)').notNullable()
    t.unique(['queue_id', 'user'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_queue_column_prefs')
  await knex.schema.alterTable('nivaro_queue_sources', (t) => {
    t.dropColumn('extra_fields')
  })
}
