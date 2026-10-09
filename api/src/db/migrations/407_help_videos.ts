import type { Knex } from 'knex'

// Help videos: tutorial recordings with stored edit instructions, versions,
// where-it-shows contexts, required viewing and per-person view tracking.
// Every table is hasTable-guarded; times are written by the app as JS UTC.
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_help_videos'))) {
    await knex.schema.createTable('nivaro_help_videos', (t) => {
      t.uuid('id').primary()
      t.string('title', 200).notNullable().defaultTo('')
      t.text('description').nullable()
      t.string('category', 100).nullable()
      t.string('status', 20).notNullable().defaultTo('draft') // draft | published | archived
      t.text('visibility').nullable() // {mode, role_ids}
      t.uuid('published_version_id').nullable()
      t.uuid('draft_version_id').nullable()
      t.integer('duration_ms').nullable()
      t.uuid('poster_file').nullable().references('id').inTable('nivaro_files')
      t.datetime('required_since').nullable()
      t.uuid('created_by').nullable().references('id').inTable('nivaro_users')
      t.uuid('updated_by').nullable().references('id').inTable('nivaro_users')
      t.datetime('created_at').notNullable()
      t.datetime('updated_at').notNullable()
      t.index(['status'], 'ix_help_videos_status')
    })
  }
  if (!(await knex.schema.hasTable('nivaro_help_video_versions'))) {
    await knex.schema.createTable('nivaro_help_video_versions', (t) => {
      t.uuid('id').primary()
      t.uuid('video_id')
        .notNullable()
        .references('id')
        .inTable('nivaro_help_videos')
        .onDelete('CASCADE')
      t.integer('version').notNullable()
      t.uuid('source_file').notNullable().references('id').inTable('nivaro_files')
      t.integer('source_duration_ms').nullable()
      t.integer('width').nullable()
      t.integer('height').nullable()
      t.text('clicks').nullable()
      t.text('levels').nullable()
      t.text('edits').notNullable()
      t.string('edits_hash', 40).notNullable()
      t.string('render_status', 20).notNullable().defaultTo('none')
      t.integer('render_progress').nullable()
      t.string('rendered_hash', 40).nullable()
      t.uuid('rendered_file').nullable().references('id').inTable('nivaro_files')
      t.uuid('captions_file').nullable().references('id').inTable('nivaro_files')
      t.uuid('poster_file').nullable().references('id').inTable('nivaro_files')
      t.string('render_error', 1000).nullable()
      t.integer('render_run_id').nullable()
      t.datetime('render_started_at').nullable()
      t.string('note', 300).nullable()
      t.uuid('created_by').nullable().references('id').inTable('nivaro_users')
      t.datetime('created_at').notNullable()
      t.unique(['video_id', 'version'], { indexName: 'ux_help_video_versions' })
      t.index(['render_status'], 'ix_help_video_versions_render')
    })
  }
  if (!(await knex.schema.hasTable('nivaro_help_video_contexts'))) {
    await knex.schema.createTable('nivaro_help_video_contexts', (t) => {
      t.increments('id')
      t.uuid('video_id')
        .notNullable()
        .references('id')
        .inTable('nivaro_help_videos')
        .onDelete('CASCADE')
      t.string('kind', 20).notNullable() // collection | page
      t.string('key', 100).notNullable()
      t.string('state_key', 100).nullable()
      t.index(['kind', 'key', 'state_key'], 'ix_help_video_contexts_lookup')
    })
  }
  if (!(await knex.schema.hasTable('nivaro_help_video_pages'))) {
    await knex.schema.createTable('nivaro_help_video_pages', (t) => {
      t.string('key', 100).primary()
      t.string('label', 200).notNullable()
      t.string('app', 50).nullable()
      t.datetime('last_seen').notNullable()
    })
  }
  if (!(await knex.schema.hasTable('nivaro_help_video_requirements'))) {
    await knex.schema.createTable('nivaro_help_video_requirements', (t) => {
      t.increments('id')
      t.uuid('video_id')
        .notNullable()
        .references('id')
        .inTable('nivaro_help_videos')
        .onDelete('CASCADE')
      t.uuid('role_id').notNullable().references('id').inTable('nivaro_roles')
      t.unique(['video_id', 'role_id'], { indexName: 'ux_help_video_requirements' })
    })
  }
  if (!(await knex.schema.hasTable('nivaro_help_video_views'))) {
    await knex.schema.createTable('nivaro_help_video_views', (t) => {
      t.increments('id')
      t.uuid('video_id')
        .notNullable()
        .references('id')
        .inTable('nivaro_help_videos')
        .onDelete('CASCADE')
      t.uuid('user').notNullable().references('id').inTable('nivaro_users')
      t.uuid('version_id').nullable()
      t.datetime('first_viewed').notNullable()
      t.datetime('last_viewed').notNullable()
      t.bigInteger('watched_ms').notNullable().defaultTo(0)
      t.integer('position_ms').notNullable().defaultTo(0)
      t.string('buckets', 20).notNullable().defaultTo('00000000000000000000')
      t.datetime('completed_at').nullable()
      t.unique(['video_id', 'user'], { indexName: 'ux_help_video_views' })
    })
  }
  if (!(await knex.schema.hasTable('nivaro_help_video_uploads'))) {
    await knex.schema.createTable('nivaro_help_video_uploads', (t) => {
      t.uuid('id').primary()
      t.uuid('user').notNullable().references('id').inTable('nivaro_users')
      t.string('mime', 100).notNullable()
      t.bigInteger('bytes_received').notNullable().defaultTo(0)
      t.integer('next_part').notNullable().defaultTo(0)
      t.integer('last_part_bytes').nullable()
      t.string('status', 20).notNullable().defaultTo('open') // open | finalized | used | abandoned
      t.string('instance', 200).nullable()
      t.uuid('file_id').nullable().references('id').inTable('nivaro_files')
      // Probe results + recorder metadata, written at finalize; video create
      // and re-record read them from here instead of trusting the client.
      t.integer('duration_ms').nullable()
      t.integer('width').nullable()
      t.integer('height').nullable()
      t.boolean('has_audio').nullable()
      t.text('meta').nullable() // {clicks, levels}
      t.datetime('created_at').notNullable()
      t.datetime('updated_at').notNullable()
      t.index(['user', 'status'], 'ix_help_video_uploads_user')
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_settings', 'help_video_author_roles'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('help_video_author_roles').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const t of [
    'nivaro_help_video_uploads',
    'nivaro_help_video_views',
    'nivaro_help_video_requirements',
    'nivaro_help_video_pages',
    'nivaro_help_video_contexts',
    'nivaro_help_video_versions',
    'nivaro_help_videos'
  ]) {
    await knex.schema.dropTableIfExists(t)
  }
  if (await knex.schema.hasColumn('nivaro_settings', 'help_video_author_roles')) {
    await knex.schema.alterTable('nivaro_settings', (t) => t.dropColumn('help_video_author_roles'))
  }
}
