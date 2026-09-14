import type { Knex } from 'knex'

/**
 * Record-form UX batch:
 *  - nivaro_collections.read_mode_toggle — show a Read-mode switch on the form
 *  - nivaro_collection_layouts.changes_tray — "changes so far" tray per layout
 *  - nivaro_item_locks.note — the holder's free-text "what I'm doing" note
 *  - nivaro_item_lock_queue — who is waiting for a lock, in order; the first
 *    row is handed the lock (socket + notification) when it is released.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_collections', 'read_mode_toggle'))) {
    await knex.schema.alterTable('nivaro_collections', (t) => {
      t.boolean('read_mode_toggle').notNullable().defaultTo(false)
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_collection_layouts', 'changes_tray'))) {
    await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
      t.boolean('changes_tray').notNullable().defaultTo(false)
    })
  }
  if (
    (await knex.schema.hasTable('nivaro_item_locks')) &&
    !(await knex.schema.hasColumn('nivaro_item_locks', 'note'))
  ) {
    await knex.schema.alterTable('nivaro_item_locks', (t) => {
      t.string('note', 300).nullable()
    })
  }
  if (!(await knex.schema.hasTable('nivaro_item_lock_queue'))) {
    await knex.schema.createTable('nivaro_item_lock_queue', (t) => {
      t.increments('id').primary()
      t.string('collection', 255).notNullable()
      t.string('item', 255).notNullable()
      t.uuid('user').notNullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
      t.datetime('requested_at').notNullable() // written as JS UTC, never a DB default
      t.unique(['collection', 'item', 'user'])
      t.index(['collection', 'item'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_item_lock_queue')
  if (await knex.schema.hasColumn('nivaro_item_locks', 'note')) {
    await knex.schema.alterTable('nivaro_item_locks', (t) => {
      t.dropColumn('note')
    })
  }
  if (await knex.schema.hasColumn('nivaro_collection_layouts', 'changes_tray')) {
    await knex.schema.alterTable('nivaro_collection_layouts', (t) => {
      t.dropColumn('changes_tray')
    })
  }
  if (await knex.schema.hasColumn('nivaro_collections', 'read_mode_toggle')) {
    await knex.schema.alterTable('nivaro_collections', (t) => {
      t.dropColumn('read_mode_toggle')
    })
  }
}
