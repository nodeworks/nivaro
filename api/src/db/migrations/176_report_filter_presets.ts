import type { Knex } from 'knex'

// Per-user named filter presets for Report Studio reports (date range +
// entity filters as JSON text). Report delete cascades; user FK NO ACTION
// per the MSSQL multi-cascade rule.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_report_filter_presets', (t) => {
    t.increments('id').primary()
    t.uuid('report').notNullable().references('id').inTable('nivaro_report_defs').onDelete('CASCADE')
    t.uuid('user').notNullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
    t.string('name', 120).notNullable()
    t.text('date_range').nullable()
    t.text('entity_filters').nullable()
    t.dateTime('created_at').defaultTo(knex.fn.now())
    t.unique(['report', 'user', 'name'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_report_filter_presets')
}
