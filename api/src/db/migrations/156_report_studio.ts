import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_report_defs', (t) => {
    t.uuid('id').primary()
    t.string('name', 255).notNullable()
    t.string('icon', 50).nullable()
    t.string('description', 500).nullable()
    t.uuid('owner').notNullable().references('id').inTable('nivaro_users').onDelete('CASCADE')
    t.boolean('is_shared').notNullable().defaultTo(false)
    t.uuid('role_id').nullable().references('id').inTable('nivaro_roles').onDelete('NO ACTION')
    t.text('global_filters').nullable() // JSON: { date_range: { preset, start?, end? } }
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now())
    t.dateTime('updated_at').notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.createTable('nivaro_report_widgets', (t) => {
    t.uuid('id').primary()
    t.uuid('report').notNullable().references('id').inTable('nivaro_report_defs').onDelete('CASCADE')
    t.string('type', 30).notNullable() // kpi | bar | line | donut | table | divider
    t.string('title', 255).notNullable()
    t.string('collection', 255).nullable()
    t.text('config').nullable() // JSON WidgetQueryConfig
    t.integer('x').notNullable().defaultTo(0)
    t.integer('y').notNullable().defaultTo(0)
    t.integer('w').notNullable().defaultTo(3)
    t.integer('h').notNullable().defaultTo(2)
    t.integer('sort').notNullable().defaultTo(0)
    t.index(['report'])
  })

  await knex.schema.createTable('nivaro_report_subscriptions', (t) => {
    t.increments('id').primary()
    t.uuid('report').notNullable().references('id').inTable('nivaro_report_defs').onDelete('CASCADE')
    t.uuid('user').notNullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
    t.string('cadence', 10).notNullable().defaultTo('daily') // daily | weekly
    t.boolean('delivery_email').notNullable().defaultTo(true)
    t.boolean('delivery_inapp').notNullable().defaultTo(true)
    t.dateTime('last_sent_at').nullable()
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now())
    t.unique(['report', 'user'])
  })

  await knex.schema.createTable('nivaro_report_alerts', (t) => {
    t.uuid('id').primary()
    t.uuid('report').notNullable().references('id').inTable('nivaro_report_defs').onDelete('CASCADE')
    t.uuid('widget').notNullable() // no FK — widget rows are bulk-replaced; alert keeps working by id match
    t.string('name', 255).notNullable()
    t.text('conditions').notNullable() // JSON [{ field: 'value'|'row_count', op, value }] AND
    t.boolean('delivery_email').notNullable().defaultTo(true)
    t.boolean('delivery_inapp').notNullable().defaultTo(true)
    t.boolean('is_active').notNullable().defaultTo(true)
    t.uuid('created_by').nullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
    t.dateTime('last_checked_at').nullable()
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now())
    t.index(['report'])
  })

  await knex.schema.createTable('nivaro_report_alert_log', (t) => {
    t.increments('id').primary()
    t.uuid('alert')
      .notNullable()
      .references('id')
      .inTable('nivaro_report_alerts')
      .onDelete('CASCADE')
    t.string('status', 20).notNullable().defaultTo('firing') // firing | resolved
    t.text('metric_snapshot').nullable() // JSON values at fire time
    t.dateTime('fired_at').notNullable().defaultTo(knex.fn.now())
    t.dateTime('resolved_at').nullable()
    t.index(['alert', 'status'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_report_alert_log')
  await knex.schema.dropTableIfExists('nivaro_report_alerts')
  await knex.schema.dropTableIfExists('nivaro_report_subscriptions')
  await knex.schema.dropTableIfExists('nivaro_report_widgets')
  await knex.schema.dropTableIfExists('nivaro_report_defs')
}
