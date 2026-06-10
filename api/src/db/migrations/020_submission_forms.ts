import type { Knex } from 'knex'

export async function up(knex: Knex) {
  await knex.schema.createTable('nivaro_submission_forms', (t) => {
    t.uuid('id').primary()
    t.specificType('name', 'nvarchar(255)').notNullable()
    t.specificType('collection', 'nvarchar(255)').notNullable()
    t.specificType('fields', 'nvarchar(max)').notNullable()
    t.specificType('token', 'nvarchar(64)').notNullable()
    t.specificType('password_hash', 'nvarchar(500)').nullable()
    t.datetime('expires_at').nullable()
    t.integer('rate_limit_per_hour').notNullable().defaultTo(60)
    t.boolean('is_active').notNullable().defaultTo(true)
    t.specificType('success_message', 'nvarchar(max)').nullable()
    t.uuid('created_by').nullable()
    t.foreign('created_by')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.datetime('created_at').notNullable()
    t.datetime('updated_at').notNullable()
  })

  await knex.schema.alterTable('nivaro_submission_forms', (t) => {
    t.unique(['token'])
  })

  await knex.schema.createTable('nivaro_submissions', (t) => {
    t.uuid('id').primary()
    t.uuid('form').notNullable()
    t.foreign('form')
      .references('id')
      .inTable('nivaro_submission_forms')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.specificType('data', 'nvarchar(max)').notNullable()
    t.specificType('ip', 'nvarchar(64)').nullable()
    t.datetime('created_at').notNullable()
  })
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('nivaro_submissions')
  await knex.schema.dropTableIfExists('nivaro_submission_forms')
}
