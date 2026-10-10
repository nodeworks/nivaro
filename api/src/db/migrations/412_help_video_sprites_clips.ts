import type { Knex } from 'knex'

// Help videos: server-side thumbnails and waveform (#1560) and short clips /
// GIFs (#1562).
//
// A finished upload gets a thumbnail sprite sheet (one JPEG of small frames,
// `sprite_file` + the `sprite` geometry JSON) and real audio peaks (`peaks`,
// a JSON array of 0–1 values per 100 ms, the shape of the recorder's
// `levels`). Both are copied onto every version made from that recording, so
// the editor's timeline reads them from the version like clicks and levels.
//
// Clips are short MP4 or GIF cuts of a version, stored as nivaro_files rows
// (hidden from the files API like every help-video file) and served through
// the ticketed media routes with the video's own visibility.
export async function up(knex: Knex): Promise<void> {
  for (const table of ['nivaro_help_video_versions', 'nivaro_help_video_uploads']) {
    if (!(await knex.schema.hasColumn(table, 'sprite_file'))) {
      await knex.schema.alterTable(table, (t) => {
        t.uuid('sprite_file').nullable().references('id').inTable('nivaro_files')
      })
    }
    if (!(await knex.schema.hasColumn(table, 'sprite'))) {
      await knex.schema.alterTable(table, (t) => {
        t.text('sprite').nullable() // {file_id, tile_w, tile_h, cols, count, interval_ms}
      })
    }
    if (!(await knex.schema.hasColumn(table, 'peaks'))) {
      await knex.schema.alterTable(table, (t) => {
        t.text('peaks').nullable() // JSON number[] (0–1 per 100 ms)
      })
    }
  }
  if (!(await knex.schema.hasTable('nivaro_help_video_clips'))) {
    await knex.schema.createTable('nivaro_help_video_clips', (t) => {
      t.uuid('id').primary()
      t.uuid('video_id')
        .notNullable()
        .references('id')
        .inTable('nivaro_help_videos')
        .onDelete('CASCADE')
      t.uuid('version_id').nullable()
      t.uuid('file_id').nullable().references('id').inTable('nivaro_files')
      t.string('kind', 10).notNullable() // mp4 | gif
      t.string('status', 20).notNullable().defaultTo('queued') // queued | rendering | ready | failed
      t.integer('progress').nullable()
      t.string('error', 500).nullable()
      t.integer('start_ms').notNullable() // edited time
      t.integer('end_ms').notNullable()
      t.string('label', 120).nullable()
      t.bigInteger('bytes').nullable()
      t.integer('width').nullable()
      t.integer('height').nullable()
      t.uuid('created_by').nullable().references('id').inTable('nivaro_users')
      t.datetime('created_at').notNullable()
      t.datetime('updated_at').notNullable()
      t.index(['video_id'], 'ix_help_video_clips_video')
      t.index(['status'], 'ix_help_video_clips_status')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_help_video_clips')
  for (const table of ['nivaro_help_video_versions', 'nivaro_help_video_uploads']) {
    for (const col of ['peaks', 'sprite', 'sprite_file']) {
      if (await knex.schema.hasColumn(table, col)) {
        await knex.schema.alterTable(table, (t) => t.dropColumn(col))
      }
    }
  }
}
