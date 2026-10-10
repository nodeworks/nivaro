import type { Knex } from 'knex'

// Help videos: "Was this helpful?" votes and questions asked at a moment
// (#1505), and the nightly "watched next" table (#1530). Every table is
// hasTable-guarded; times are written by the app as JS UTC Dates.
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_help_video_ratings'))) {
    await knex.schema.createTable('nivaro_help_video_ratings', (t) => {
      t.increments('id')
      t.uuid('video_id')
        .notNullable()
        .references('id')
        .inTable('nivaro_help_videos')
        .onDelete('CASCADE')
      t.uuid('user').notNullable().references('id').inTable('nivaro_users')
      t.uuid('version_id').nullable()
      t.boolean('helpful').notNullable()
      t.datetime('created_at').notNullable()
      t.datetime('updated_at').notNullable()
      t.unique(['video_id', 'user'], { indexName: 'ux_help_video_ratings' })
    })
  }
  if (!(await knex.schema.hasTable('nivaro_help_video_questions'))) {
    await knex.schema.createTable('nivaro_help_video_questions', (t) => {
      t.uuid('id').primary()
      t.uuid('video_id')
        .notNullable()
        .references('id')
        .inTable('nivaro_help_videos')
        .onDelete('CASCADE')
      t.uuid('version_id').nullable()
      t.uuid('user').notNullable().references('id').inTable('nivaro_users')
      // Where in the finished video (edited time) the question was asked.
      t.integer('at_ms').notNullable().defaultTo(0)
      t.string('text', 1000).notNullable()
      t.string('answer', 2000).nullable()
      t.uuid('answered_by').nullable().references('id').inTable('nivaro_users')
      t.datetime('answered_at').nullable()
      t.datetime('created_at').notNullable()
      t.index(['video_id', 'created_at'], 'ix_help_video_questions_video')
    })
  }
  if (!(await knex.schema.hasTable('nivaro_help_video_next'))) {
    await knex.schema.createTable('nivaro_help_video_next', (t) => {
      t.increments('id')
      t.uuid('video_id')
        .notNullable()
        .references('id')
        .inTable('nivaro_help_videos')
        .onDelete('CASCADE')
      t.uuid('next_video_id')
        .notNullable()
        .references('id')
        .inTable('nivaro_help_videos')
        .onDelete('CASCADE')
      // Null = people in any role.
      t.uuid('role_id').nullable()
      t.float('score').notNullable().defaultTo(0)
      t.datetime('computed_at').notNullable()
      t.index(['video_id', 'role_id'], 'ix_help_video_next_lookup')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const t of [
    'nivaro_help_video_next',
    'nivaro_help_video_questions',
    'nivaro_help_video_ratings'
  ]) {
    await knex.schema.dropTableIfExists(t)
  }
}
