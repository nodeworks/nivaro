import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queues', (t) => {
    t.boolean('materialized').notNullable().defaultTo(false)
  })

  await knex.schema.createTable('nivaro_queue_items', (t) => {
    t.increments('id').primary()
    t.uuid('queue_id').notNullable().references('id').inTable('nivaro_queues').onDelete('CASCADE')
    // NO ACTION (not CASCADE): nivaro_queue_sources.queue_id already cascades from
    // nivaro_queues, so a CASCADE here too would create a multi-cascade-path
    // diamond back to nivaro_queues (MSSQL error 1785). queue_id's own CASCADE
    // above already cleans up this table when the queue is deleted.
    t.integer('source_id')
      .notNullable()
      .references('id')
      .inTable('nivaro_queue_sources')
      .onDelete('NO ACTION')
    t.string('collection', 255).notNullable()
    t.string('item_id', 255).notNullable()
    t.string('label', 500).nullable()
    t.string('state', 36).nullable()
    t.string('state_color', 20).nullable()
    t.datetime('entered_state_at').nullable()
    t.decimal('sla_duration_hours', 10, 2).nullable()
    t.integer('sla_warning_pct').nullable()
    t.boolean('sla_business_hours_only').notNullable().defaultTo(false)
    t.boolean('at_risk').notNullable().defaultTo(false)
    t.string('at_risk_color', 10).nullable()
    t.specificType('owner_names', 'nvarchar(max)').nullable()
    t.uuid('claimed_by').nullable().references('id').inTable('nivaro_users')
    t.specificType('extra', 'nvarchar(max)').nullable()
    t.string('url', 500).notNullable()
    t.datetime('updated_at').notNullable()
    t.unique(['queue_id', 'source_id', 'collection', 'item_id'])
  })

  await knex.schema.createTable('nivaro_queue_item_owners', (t) => {
    t.increments('id').primary()
    t.integer('queue_item_id')
      .notNullable()
      .references('id')
      .inTable('nivaro_queue_items')
      .onDelete('CASCADE')
    t.uuid('user_id').notNullable().references('id').inTable('nivaro_users')
    t.unique(['queue_item_id', 'user_id'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_queue_item_owners')
  await knex.schema.dropTableIfExists('nivaro_queue_items')
  await knex.schema.alterTable('nivaro_queues', (t) => {
    t.dropColumn('materialized')
  })
}
