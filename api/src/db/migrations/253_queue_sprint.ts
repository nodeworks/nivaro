import type { Knex } from 'knex'

/**
 * Queues sprint: triage labels (#109) + saved-view queue subscriptions (#379)
 * + instant queue-entry watermarks (#121).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_queue_labels'))) {
    await knex.schema.createTable('nivaro_queue_labels', (t) => {
      t.increments('id')
      t.uuid('queue_id').notNullable().references('id').inTable('nivaro_queues').onDelete('CASCADE')
      t.string('collection', 255).notNullable()
      t.string('item_id', 255).notNullable()
      t.string('label', 60).notNullable()
      t.uuid('created_by').nullable()
      t.datetime('created_at').notNullable()
      t.unique(['queue_id', 'collection', 'item_id', 'label'], {
        indexName: 'uq_queue_label'
      })
      t.index(['queue_id'], 'idx_queue_labels_queue')
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_notification_subscriptions', 'queue_view_id'))) {
    await knex.schema.alterTable('nivaro_notification_subscriptions', (t) => {
      // Saved-view scoping for queue subscriptions (#379). No FK — view
      // deletes null it via the route, stale ids simply never match.
      t.integer('queue_view_id').nullable()
      // Instant queue-entry watermark (#121): last seen item ids (JSON) or
      // {count} when over the cap — the view-subscriptions pattern.
      t.text('queue_last_ids').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_queue_labels')
  await knex.schema.alterTable('nivaro_notification_subscriptions', (t) => {
    t.dropColumn('queue_view_id')
    t.dropColumn('queue_last_ids')
  })
}
