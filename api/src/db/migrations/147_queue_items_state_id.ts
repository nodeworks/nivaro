import type { Knex } from 'knex'

/**
 * Predictive SLA on materialized queues: cached rows need the workflow state
 * UUID (the label/key already stored is not unique across templates) so the
 * read path can compare time-in-state against per-state historical
 * percentiles. Existing caches carry NULL until their next rebuild —
 * prediction simply stays off for them.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queue_items', (t) => {
    t.string('state_id', 36)
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queue_items', (t) => {
    t.dropColumn('state_id')
  })
}
