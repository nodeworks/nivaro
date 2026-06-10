import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_record_templates', (t) => {
    t.increments('id')
    t.string('collection', 255).notNullable()
    t.string('name', 255).notNullable()
    t.string('description', 500).nullable()
    t.specificType('data', 'nvarchar(max)').notNullable()
    t.uuid('role_id').nullable()
    t.foreign('role_id')
      .references('id')
      .inTable('nivaro_roles')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.boolean('is_shared').notNullable().defaultTo(true)
    t.uuid('created_by').nullable()
    t.foreign('created_by')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.datetime('created_at').defaultTo(knex.fn.now())
    t.datetime('updated_at').defaultTo(knex.fn.now())
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_record_templates')
}
