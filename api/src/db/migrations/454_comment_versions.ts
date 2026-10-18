import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Migration 454 — comment edit history.
 *
 * `nivaro_comment_versions` keeps the text a comment had before each edit (and before a delete);
 * `nivaro_comments` gains `deleted_at` / `deleted_by` so a deleted comment stays as a tombstone.
 * Additive and guarded.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_comments'))) return
  for (const col of ['deleted_at', 'deleted_by'] as const) {
    if (!(await knex.schema.hasColumn('nivaro_comments', col))) {
      await knex.schema.alterTable('nivaro_comments', (t) => {
        if (col === 'deleted_at') t.timestamp('deleted_at').nullable()
        else t.uuid('deleted_by').nullable()
      })
    }
  }
  if (!(await knex.schema.hasTable('nivaro_comment_versions'))) {
    await knex.schema.createTable('nivaro_comment_versions', (t) => {
      t.increments('id')
      t.uuid('comment')
        .notNullable()
        .references('id')
        .inTable('nivaro_comments')
        .onDelete('CASCADE')
      t.integer('version').notNullable()
      t.text('text').notNullable()
      t.uuid('user').nullable()
      t.timestamp('created_at').notNullable().defaultTo(utcNow(knex))
      t.unique(['comment', 'version'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_comment_versions')
  if (!(await knex.schema.hasTable('nivaro_comments'))) return
  for (const col of ['deleted_at', 'deleted_by']) {
    if (await knex.schema.hasColumn('nivaro_comments', col)) {
      await knex.schema.alterTable('nivaro_comments', (t) => {
        t.dropColumn(col)
      })
    }
  }
}
