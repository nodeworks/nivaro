import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_dashboard_links', (t) => {
    t.increments('id').primary()
    t.uuid('dashboard').notNullable().references('id').inTable('nivaro_dashboards').onDelete('CASCADE')
    t.string('token', 96).notNullable().unique()
    t.dateTime('expires_at').nullable()
    t.boolean('is_active').notNullable().defaultTo(true)
    t.integer('view_count').notNullable().defaultTo(0)
    t.uuid('created_by').nullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now())
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_dashboard_links')
}
