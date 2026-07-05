import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_queue_stat_snapshots', (t) => {
    t.increments('id').primary()
    t.uuid('queue_id').notNullable().references('id').inTable('nivaro_queues').onDelete('CASCADE')
    t.date('snapshot_date').notNullable()
    t.integer('total').notNullable().defaultTo(0)
    t.integer('unowned').notNullable().defaultTo(0)
    t.integer('sla_warning').notNullable().defaultTo(0)
    t.integer('sla_breached').notNullable().defaultTo(0)
    t.integer('at_risk').notNullable().defaultTo(0)
    // JSON: Record<state, count>
    t.specificType('by_state', 'nvarchar(max)').nullable()
    t.datetime('created_at').notNullable()
    t.unique(['queue_id', 'snapshot_date'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_queue_stat_snapshots')
}
