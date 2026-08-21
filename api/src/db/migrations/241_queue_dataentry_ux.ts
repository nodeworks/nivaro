import type { Knex } from 'knex'

/**
 * Queue & data-entry UX batch:
 *  - nivaro_comment_reactions — 👍/✅ on record comments (chat's fixed palette)
 *  - nivaro_bulk_recipes     — saved bulk update/transition presets per collection
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_comment_reactions'))) {
    await knex.schema.createTable('nivaro_comment_reactions', (t) => {
      t.increments('id').primary()
      t.uuid('comment')
        .notNullable()
        .references('id')
        .inTable('nivaro_comments')
        .onDelete('CASCADE')
      t.uuid('user').notNullable().references('id').inTable('nivaro_users')
      t.string('emoji', 16).notNullable()
      t.datetime('created_at').notNullable().defaultTo(knex.fn.now())
      t.unique(['comment', 'user', 'emoji'])
    })
  }

  if (!(await knex.schema.hasTable('nivaro_bulk_recipes'))) {
    await knex.schema.createTable('nivaro_bulk_recipes', (t) => {
      t.increments('id').primary()
      t.string('collection', 255).notNullable()
      t.string('name', 200).notNullable()
      t.string('action_type', 20).notNullable() // 'update' | 'transition'
      t.text('config').notNullable() // JSON: {field, value} | {transition_label}
      t.boolean('is_shared').notNullable().defaultTo(true)
      t.uuid('created_by').nullable().references('id').inTable('nivaro_users')
      t.datetime('created_at').notNullable().defaultTo(knex.fn.now())
      t.index(['collection'])
    })
  }

}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_bulk_recipes')
  await knex.schema.dropTableIfExists('nivaro_comment_reactions')
}
