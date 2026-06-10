import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_pages', (t) => {
    t.increments('id')
    t.string('name', 255).notNullable()
    t.string('slug', 100).notNullable()
    t.string('icon', 50).nullable()
    t.specificType('layout', 'nvarchar(max)').notNullable()
    t.boolean('is_shared').notNullable().defaultTo(true)
    t.uuid('role').nullable() // nivaro_roles uses a uniqueidentifier PK
    t.foreign('role')
      .references('id')
      .inTable('nivaro_roles')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.integer('sort').notNullable().defaultTo(0)
    t.uuid('created_by').notNullable()
    t.foreign('created_by')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.datetime('created_at').defaultTo(knex.fn.now())
    t.datetime('updated_at').defaultTo(knex.fn.now())
  })
  await knex.raw('ALTER TABLE nivaro_pages ADD CONSTRAINT uq_nivaro_pages_slug UNIQUE (slug)')
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_pages')
}
