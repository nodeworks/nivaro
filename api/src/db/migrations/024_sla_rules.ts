import type { Knex } from 'knex'

export async function up(knex: Knex) {
  await knex.schema.createTable('nivaro_sla_rules', (t) => {
    t.increments('id').primary()
    t.uuid('workflow_template').notNullable()
    t.foreign('workflow_template')
      .references('id')
      .inTable('nivaro_workflow_templates')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.specificType('state_key', 'nvarchar(255)').notNullable()
    t.specificType('name', 'nvarchar(255)').notNullable()
    t.integer('duration_hours').notNullable()
    t.integer('warning_threshold_pct').notNullable().defaultTo(80)
    t.boolean('business_hours_only').notNullable().defaultTo(false)
    t.boolean('notify_on_warning').notNullable().defaultTo(true)
    t.boolean('notify_on_breach').notNullable().defaultTo(true)
    t.uuid('escalation_user').nullable()
    t.foreign('escalation_user')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.boolean('is_active').notNullable().defaultTo(true)
    t.datetime('created_at').notNullable()
    t.datetime('updated_at').notNullable()
  })
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('nivaro_sla_rules')
}
