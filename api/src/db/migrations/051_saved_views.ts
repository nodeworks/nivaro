import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_saved_views', (t) => {
    t.increments('id')
    t.string('collection', 100).notNullable()
    t.string('name', 255).notNullable()
    t.specificType('filters', 'nvarchar(max)').notNullable()
    t.specificType('sort', 'nvarchar(max)').nullable()
    t.specificType('columns', 'nvarchar(max)').nullable()
    t.uuid('user').notNullable()
    t.foreign('user')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.boolean('is_shared').notNullable().defaultTo(false)
    t.uuid('role').nullable() // nivaro_roles uses a uniqueidentifier PK
    t.foreign('role')
      .references('id')
      .inTable('nivaro_roles')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.datetime('created_at').defaultTo(knex.fn.now())
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_saved_views')
}
