import type { Knex } from 'knex'

export async function up(knex: Knex) {
  await knex.schema.createTable('nivaro_field_watches', (t) => {
    t.increments('id').primary()
    t.specificType('name', 'nvarchar(255)').notNullable()
    t.specificType('collection', 'nvarchar(255)').notNullable()
    t.specificType('field', 'nvarchar(255)').notNullable()
    t.boolean('is_active').notNullable().defaultTo(true)
    t.uuid('created_by').nullable()
    t.foreign('created_by')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.datetime('created_at').notNullable()
    t.datetime('updated_at').notNullable()
  })

  await knex.schema.createTable('nivaro_field_watch_subscribers', (t) => {
    t.increments('id').primary()
    t.integer('watch').notNullable()
    t.foreign('watch')
      .references('id')
      .inTable('nivaro_field_watches')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.uuid('user').notNullable()
    t.foreign('user')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.unique(['watch', 'user'])
  })
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('nivaro_field_watch_subscribers')
  await knex.schema.dropTableIfExists('nivaro_field_watches')
}
