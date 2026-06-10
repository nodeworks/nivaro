import type { Knex } from 'knex'

export async function up(knex: Knex) {
  await knex.schema.createTable('nivaro_import_jobs', (t) => {
    t.uuid('id').primary()
    t.specificType('collection', 'nvarchar(255)').notNullable()
    t.specificType('file_name', 'nvarchar(500)').notNullable()
    t.specificType('csv_data', 'nvarchar(max)').notNullable()
    t.specificType('column_map', 'nvarchar(max)').nullable()
    t.specificType('duplicate_strategy', 'nvarchar(50)').notNullable().defaultTo('skip')
    t.specificType('id_field', 'nvarchar(255)').nullable()
    t.specificType('status', 'nvarchar(50)').notNullable().defaultTo('pending')
    t.integer('total_rows').nullable()
    t.integer('processed_rows').nullable().defaultTo(0)
    t.integer('created_rows').nullable().defaultTo(0)
    t.integer('updated_rows').nullable().defaultTo(0)
    t.integer('skipped_rows').nullable().defaultTo(0)
    t.integer('error_rows').nullable().defaultTo(0)
    t.specificType('errors', 'nvarchar(max)').nullable()
    t.uuid('created_by').nullable()
    t.foreign('created_by')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.datetime('created_at').notNullable()
    t.datetime('started_at').nullable()
    t.datetime('completed_at').nullable()
  })
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('nivaro_import_jobs')
}
