import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_queue_owner_snapshots', (t) => {
    t.increments('id').primary()
    t.uuid('queue_id')
      .notNullable()
      .references('id')
      .inTable('nivaro_queues')
      .onDelete('CASCADE')
    t.date('snapshot_date').notNullable()
    // NO ACTION: multiple cascade paths to nivaro_users are rejected by MSSQL
    t.uuid('user').notNullable().references('id').inTable('nivaro_users')
    t.integer('owned').notNullable().defaultTo(0)
    t.integer('sla_warning').notNullable().defaultTo(0)
    t.integer('sla_breached').notNullable().defaultTo(0)
    t.integer('at_risk').notNullable().defaultTo(0)
    t.datetime('created_at').defaultTo(knex.fn.now())
    t.unique(['queue_id', 'snapshot_date', 'user'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_queue_owner_snapshots')
}
