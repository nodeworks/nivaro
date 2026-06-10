import type { Knex } from 'knex'

export async function up(knex: Knex) {
  if (!(await knex.schema.hasTable('nivaro_comments'))) {
    await knex.schema.createTable('nivaro_comments', (t) => {
      t.uuid('id').primary().notNullable()
      t.string('collection', 255).notNullable()
      t.string('item', 255).notNullable()
      t.uuid('user').notNullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
      t.specificType('text', 'nvarchar(max)').notNullable()
      t.dateTime('created_at').notNullable().defaultTo(knex.fn.now())
      t.dateTime('updated_at').notNullable().defaultTo(knex.fn.now())
      t.index(['collection', 'item'], 'idx_nivaro_comments_record')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_comment_mentions'))) {
    await knex.schema.createTable('nivaro_comment_mentions', (t) => {
      t.increments('id').primary()
      // NO ACTION for both FKs — MSSQL rejects multiple cascade paths to same table
      t.uuid('comment')
        .notNullable()
        .references('id')
        .inTable('nivaro_comments')
        .onDelete('NO ACTION')
      t.uuid('user').notNullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
      t.index(['comment'], 'idx_nivaro_comment_mentions_comment')
    })
  }
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('nivaro_comment_mentions')
  await knex.schema.dropTableIfExists('nivaro_comments')
}
