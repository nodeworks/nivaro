import type { Knex } from 'knex'
import { longText } from '../portable-ddl.js'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queue_sources', (t) => {
    longText(t, knex, 'extra_fields').nullable()
  })

  await knex.schema.createTable('nivaro_queue_column_prefs', (t) => {
    t.increments('id').primary()
    t.uuid('queue_id').notNullable().references('id').inTable('nivaro_queues').onDelete('CASCADE')
    t.uuid('user').notNullable().references('id').inTable('nivaro_users')
    longText(t, knex, 'visible_columns').notNullable()
    t.unique(['queue_id', 'user'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_queue_column_prefs')
  await knex.schema.alterTable('nivaro_queue_sources', (t) => {
    t.dropColumn('extra_fields')
  })
}
