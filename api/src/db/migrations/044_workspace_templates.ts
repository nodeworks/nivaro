import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_workspace_templates', (t) => {
    t.increments('id')
    t.string('name', 255).notNullable()
    t.specificType('description', 'nvarchar(max)').nullable()
    t.uuid('source_workspace').nullable()
    // JSON: { collections, fields, relations, roles, workflows }
    t.specificType('data', 'nvarchar(max)').notNullable()
    t.uuid('created_by').notNullable()
    t.foreign('created_by')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.datetime('created_at').defaultTo(knex.fn.now())
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_workspace_templates')
}
