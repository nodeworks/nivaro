import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_hierarchy_configs', (t) => {
    t.increments('id')
    t.string('name', 255).notNullable()
    t.text('description').nullable()
    t.specificType('levels', 'nvarchar(max)').notNullable().defaultTo('[]') // JSON array of HierarchyLevel
    t.datetime('created_at').defaultTo(knex.fn.now())
    // nivaro_users.id is a uuid; existing FKs all use uuid + NO ACTION (MSSQL multi-cascade rules)
    t.uuid('created_by').nullable()
    t.foreign('created_by')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_hierarchy_configs')
}
