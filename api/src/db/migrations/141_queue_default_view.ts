import type { Knex } from 'knex'

// Per-viewer default saved view for a queue. Lives on the existing per-(queue,
// user) prefs row. Plain nullable int (no FK): nivaro_queue_column_prefs already
// CASCADEs from the queue, and nivaro_queue_views also CASCADEs from the queue —
// a second FK to queue_views would be a multi-cascade path (MSSQL error 1785).
// A stale id (view deleted) simply never applies; the view DELETE route also
// nulls it out.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queue_column_prefs', (t) => {
    t.integer('default_view_id').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queue_column_prefs', (t) => {
    t.dropColumn('default_view_id')
  })
}
