import type { Knex } from 'knex'

/**
 * Reactions for RECORDED notes (transition comments, change reasons, legacy
 * note rows, addendum reasons): those entries aren't nivaro_comments rows, so
 * the comment-FK reactions table can't hold them. Keyed by the related-thread
 * entry id ('transition:123', 'reason:456', …) + the record it renders on.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_entry_reactions'))) {
    await knex.schema.createTable('nivaro_entry_reactions', (t) => {
      t.increments('id').primary()
      t.string('collection', 255).notNullable()
      t.string('item', 255).notNullable()
      t.string('entry_key', 200).notNullable()
      t.uuid('user').notNullable().references('id').inTable('nivaro_users')
      t.string('emoji', 16).notNullable()
      t.datetime('created_at').notNullable().defaultTo(knex.fn.now())
      t.unique(['entry_key', 'user', 'emoji'])
      t.index(['collection', 'item'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_entry_reactions')
}
