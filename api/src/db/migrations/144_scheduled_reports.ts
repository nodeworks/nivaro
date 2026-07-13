import type { Knex } from 'knex'

/**
 * Scheduled reports — email a PDF snapshot on a cron.
 *
 * report_type:
 *   'collection' — rows from a collection (filters + fields) as a table
 *   'queue'      — a queue's stat strip + current items summary
 *
 * queue_id has NO FK on purpose: nivaro_queues already CASCADEs seven child
 * tables; the run route validates existence and the cron skips dangling ids.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_scheduled_reports', (t) => {
    t.increments('id').primary()
    t.string('name', 255).notNullable()
    t.string('report_type', 20).notNullable().defaultTo('collection')
    t.string('collection', 255)
    t.string('queue_id', 36)
    t.text('filters') // JSON QueueCondition-style [{field,op,value}]
    t.text('fields') // JSON string[] — columns for collection reports
    t.text('recipients').notNullable() // JSON string[] of emails
    t.string('cron_schedule', 100).notNullable()
    t.string('orientation', 10).notNullable().defaultTo('portrait')
    t.integer('row_limit').notNullable().defaultTo(100)
    t.boolean('is_active').notNullable().defaultTo(true)
    t.datetime('last_run_at')
    t.string('last_run_status', 500)
    t.uuid('created_by').references('id').inTable('nivaro_users')
    t.datetime('created_at').defaultTo(knex.fn.now())
    t.datetime('updated_at').defaultTo(knex.fn.now())
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('nivaro_scheduled_reports')
}
