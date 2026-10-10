import type { Knex } from 'knex'

// Learning paths (#1508): ordered video lists assigned to roles, with a
// "New User" switch for people who just got their account. Progress is read
// from nivaro_help_video_views (no table of its own). Also the two columns a
// broadcast uses to carry a video moment (#1528a) and the per-release video
// shown on the changelog (#1528b). Every change is hasTable/hasColumn-guarded;
// times are written by the app as JS UTC Dates.
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_help_video_paths'))) {
    await knex.schema.createTable('nivaro_help_video_paths', (t) => {
      t.uuid('id').primary()
      t.string('title', 200).notNullable().defaultTo('')
      t.text('description').nullable()
      t.string('status', 20).notNullable().defaultTo('draft') // draft | published
      t.boolean('new_user').notNullable().defaultTo(false)
      t.uuid('created_by').nullable().references('id').inTable('nivaro_users')
      t.uuid('updated_by').nullable().references('id').inTable('nivaro_users')
      t.datetime('created_at').notNullable()
      t.datetime('updated_at').notNullable()
      t.index(['status'], 'ix_help_video_paths_status')
    })
  }
  if (!(await knex.schema.hasTable('nivaro_help_video_path_items'))) {
    await knex.schema.createTable('nivaro_help_video_path_items', (t) => {
      t.increments('id')
      t.uuid('path_id')
        .notNullable()
        .references('id')
        .inTable('nivaro_help_video_paths')
        .onDelete('CASCADE')
      t.uuid('video_id').notNullable().references('id').inTable('nivaro_help_videos')
      t.integer('position').notNullable().defaultTo(0)
      t.unique(['path_id', 'video_id'], { indexName: 'ux_help_video_path_items' })
      t.index(['video_id'], 'ix_help_video_path_items_video')
    })
  }
  if (!(await knex.schema.hasTable('nivaro_help_video_path_roles'))) {
    await knex.schema.createTable('nivaro_help_video_path_roles', (t) => {
      t.increments('id')
      t.uuid('path_id')
        .notNullable()
        .references('id')
        .inTable('nivaro_help_video_paths')
        .onDelete('CASCADE')
      t.uuid('role_id').notNullable().references('id').inTable('nivaro_roles')
      t.boolean('required').notNullable().defaultTo(false)
      t.unique(['path_id', 'role_id'], { indexName: 'ux_help_video_path_roles' })
      t.index(['role_id'], 'ix_help_video_path_roles_role')
    })
  }
  // A broadcast can point at a moment in a video (#1528a).
  if (await knex.schema.hasTable('nivaro_announcements')) {
    if (!(await knex.schema.hasColumn('nivaro_announcements', 'help_video_id'))) {
      await knex.schema.alterTable('nivaro_announcements', (t) => {
        t.uuid('help_video_id').nullable()
      })
    }
    if (!(await knex.schema.hasColumn('nivaro_announcements', 'help_video_t_ms'))) {
      await knex.schema.alterTable('nivaro_announcements', (t) => {
        t.integer('help_video_t_ms').nullable()
      })
    }
  }
  // One video per release on the changelog (#1528b), keyed by version.
  if (!(await knex.schema.hasTable('nivaro_help_video_release_videos'))) {
    await knex.schema.createTable('nivaro_help_video_release_videos', (t) => {
      t.string('version', 40).primary()
      t.uuid('video_id')
        .notNullable()
        .references('id')
        .inTable('nivaro_help_videos')
        .onDelete('CASCADE')
      t.integer('t_ms').nullable()
      t.uuid('created_by').nullable().references('id').inTable('nivaro_users')
      t.uuid('updated_by').nullable().references('id').inTable('nivaro_users')
      t.datetime('created_at').notNullable()
      t.datetime('updated_at').notNullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const t of [
    'nivaro_help_video_release_videos',
    'nivaro_help_video_path_roles',
    'nivaro_help_video_path_items',
    'nivaro_help_video_paths'
  ]) {
    await knex.schema.dropTableIfExists(t)
  }
  if (await knex.schema.hasTable('nivaro_announcements')) {
    for (const col of ['help_video_t_ms', 'help_video_id']) {
      if (await knex.schema.hasColumn('nivaro_announcements', col)) {
        await knex.schema.alterTable('nivaro_announcements', (t) => t.dropColumn(col))
      }
    }
  }
}
