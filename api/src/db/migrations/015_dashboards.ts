import type { Knex } from 'knex'

export async function up(knex: Knex) {
  await knex.schema.createTable('nivaro_dashboards', (t) => {
    t.uuid('id').primary().notNullable()
    t.string('name', 255).notNullable()
    t.uuid('user').nullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
    t.boolean('is_shared').notNullable().defaultTo(false)
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now())
    t.dateTime('updated_at').notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.createTable('nivaro_dashboard_widgets', (t) => {
    t.uuid('id').primary().notNullable()
    t.uuid('dashboard')
      .notNullable()
      .references('id')
      .inTable('nivaro_dashboards')
      .onDelete('NO ACTION')
    t.string('type', 50).notNullable() // 'count'|'sum'|'avg'|'latest'|'bar_chart'|'line_chart'
    t.string('title', 255).notNullable()
    t.string('collection', 255).nullable()
    t.string('field', 255).nullable()
    t.specificType('filters', 'nvarchar(max)').nullable() // JSON string
    t.integer('col').notNullable().defaultTo(0)
    t.integer('row').notNullable().defaultTo(0)
    t.integer('width').notNullable().defaultTo(1)
    t.integer('height').notNullable().defaultTo(1)
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now())
  })
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('nivaro_dashboard_widgets')
  await knex.schema.dropTableIfExists('nivaro_dashboards')
}
