import type { Knex } from 'knex'

export async function up(knex: Knex) {
  await knex.schema.createTable('nivaro_alert_definitions', (t) => {
    t.increments('id').primary()
    t.specificType('name', 'nvarchar(255)').notNullable()
    t.specificType('category', 'nvarchar(100)').notNullable().defaultTo('general')
    t.specificType('collection', 'nvarchar(255)').notNullable()
    t.specificType('field', 'nvarchar(255)').notNullable()
    t.specificType('operator', 'nvarchar(50)').notNullable()
    t.float('threshold').notNullable()
    t.specificType('unit', 'nvarchar(50)').notNullable().defaultTo('count')
    t.specificType('filters', 'nvarchar(max)').nullable()
    t.integer('cooldown_minutes').notNullable().defaultTo(60)
    t.boolean('is_active').notNullable().defaultTo(true)
    t.uuid('created_by').nullable()
    t.foreign('created_by')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.datetime('created_at').notNullable()
    t.datetime('updated_at').notNullable()
  })

  await knex.schema.createTable('nivaro_alert_subscriptions', (t) => {
    t.increments('id').primary()
    t.integer('alert_definition').notNullable()
    t.foreign('alert_definition')
      .references('id')
      .inTable('nivaro_alert_definitions')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.uuid('user').notNullable()
    t.foreign('user')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.boolean('notify_email').notNullable().defaultTo(true)
    t.boolean('notify_inapp').notNullable().defaultTo(true)
    t.unique(['alert_definition', 'user'])
  })

  await knex.schema.createTable('nivaro_alert_log', (t) => {
    t.increments('id').primary()
    t.integer('alert_definition').notNullable()
    t.foreign('alert_definition')
      .references('id')
      .inTable('nivaro_alert_definitions')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.specificType('collection', 'nvarchar(255)').notNullable()
    t.specificType('item', 'nvarchar(255)').notNullable()
    t.specificType('field_value', 'nvarchar(500)').nullable()
    t.datetime('triggered_at').notNullable()
  })
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('nivaro_alert_log')
  await knex.schema.dropTableIfExists('nivaro_alert_subscriptions')
  await knex.schema.dropTableIfExists('nivaro_alert_definitions')
}
