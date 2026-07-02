import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_notification_subscriptions', (t) => {
    t.uuid('queue_id').nullable()
    t.foreign('queue_id').references('id').inTable('nivaro_queues').onDelete('CASCADE')
  })
  await knex.schema.alterTable('nivaro_notification_subscriptions', (t) => {
    t.string('collection', 255).nullable().alter()
  })

  await knex.schema.alterTable('nivaro_widget_feeds', (t) => {
    t.uuid('queue_id').nullable()
    t.foreign('queue_id').references('id').inTable('nivaro_queues').onDelete('CASCADE')
  })
  await knex.schema.alterTable('nivaro_widget_feeds', (t) => {
    t.string('collection', 100).nullable().alter()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_widget_feeds', (t) => {
    t.dropForeign('queue_id')
    t.dropColumn('queue_id')
  })
  await knex.schema.alterTable('nivaro_widget_feeds', (t) => {
    t.string('collection', 100).notNullable().alter()
  })

  await knex.schema.alterTable('nivaro_notification_subscriptions', (t) => {
    t.dropForeign('queue_id')
    t.dropColumn('queue_id')
  })
  await knex.schema.alterTable('nivaro_notification_subscriptions', (t) => {
    t.string('collection', 255).notNullable().alter()
  })
}
