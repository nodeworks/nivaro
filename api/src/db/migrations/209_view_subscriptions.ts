import type { Knex } from 'knex'

/**
 * Saved-view subscriptions — "which records ENTERED my filtered view since I
 * last looked".
 *
 * Notification subscriptions fire per write event; nothing answered the set
 * question ("7 workflows entered 'Zone 1 over $500k' yesterday"), which is
 * how people actually watch a slice of the data. Each subscription snapshots
 * the view's matched-id set per digest run (`last_ids`, capped — a view too
 * large to snapshot degrades to count-only deltas) and the next run diffs
 * against it.
 *
 * `view_id` CASCADEs — a deleted view takes its subscriptions with it, which
 * is correct: there is no view left to diff.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_view_subscriptions')) return
  await knex.schema.createTable('nivaro_view_subscriptions', (t) => {
    t.increments('id')
    t.integer('view_id')
      .notNullable()
      .references('id')
      .inTable('nivaro_saved_views')
      .onDelete('CASCADE')
    t.uuid('user').notNullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
    t.string('digest', 20).notNullable().defaultTo('daily') // daily | weekly
    t.boolean('is_active').notNullable().defaultTo(true)
    t.text('last_ids').nullable() // JSON string[] snapshot, or {"count": n} when too large
    t.dateTime('last_run_at').nullable()
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now())
    t.unique(['view_id', 'user'])
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_view_subscriptions'))) return
  await knex.schema.dropTable('nivaro_view_subscriptions')
}
