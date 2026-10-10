import type { Knex } from 'knex'

// Help videos: "may be out of date" flags (#1495) and storage housekeeping
// (#1531). Every change is guarded; times are written by the app as JS UTC.
//
//   nivaro_help_videos.stale_reason        JSON {kind, detail, since} or NULL
//   nivaro_help_videos.stale_dismissed_at  when an author dismissed the flag
//   nivaro_help_video_pages.labels         JSON list of click labels seen on the page
//   nivaro_help_video_pages.labels_at      when that list was last reported
//   nivaro_help_video_versions.files_removed_at  retention removed this version's files
//
// A version whose files were removed keeps its row with every file column
// NULL, so source_file becomes nullable (its foreign key is dropped and put
// back, as SQL Server cannot alter a column inside a constraint).
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_help_videos')) {
    if (!(await knex.schema.hasColumn('nivaro_help_videos', 'stale_reason'))) {
      await knex.schema.alterTable('nivaro_help_videos', (t) => {
        t.text('stale_reason').nullable()
      })
    }
    if (!(await knex.schema.hasColumn('nivaro_help_videos', 'stale_dismissed_at'))) {
      await knex.schema.alterTable('nivaro_help_videos', (t) => {
        t.datetime('stale_dismissed_at').nullable()
      })
    }
  }
  if (await knex.schema.hasTable('nivaro_help_video_pages')) {
    if (!(await knex.schema.hasColumn('nivaro_help_video_pages', 'labels'))) {
      await knex.schema.alterTable('nivaro_help_video_pages', (t) => {
        t.text('labels').nullable()
      })
    }
    if (!(await knex.schema.hasColumn('nivaro_help_video_pages', 'labels_at'))) {
      await knex.schema.alterTable('nivaro_help_video_pages', (t) => {
        t.datetime('labels_at').nullable()
      })
    }
  }
  if (await knex.schema.hasTable('nivaro_help_video_versions')) {
    if (!(await knex.schema.hasColumn('nivaro_help_video_versions', 'files_removed_at'))) {
      await knex.schema.alterTable('nivaro_help_video_versions', (t) => {
        t.datetime('files_removed_at').nullable()
      })
      await knex.schema.alterTable('nivaro_help_video_versions', (t) => {
        t.dropForeign(['source_file'])
      })
      await knex.schema.alterTable('nivaro_help_video_versions', (t) => {
        t.uuid('source_file').nullable().alter()
      })
      await knex.schema.alterTable('nivaro_help_video_versions', (t) => {
        t.foreign('source_file').references('id').inTable('nivaro_files')
      })
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_help_video_versions')) {
    if (await knex.schema.hasColumn('nivaro_help_video_versions', 'files_removed_at')) {
      // Rows whose files were removed cannot go back to a NOT NULL source.
      await knex('nivaro_help_video_versions').whereNull('source_file').delete()
      await knex.schema.alterTable('nivaro_help_video_versions', (t) => {
        t.dropForeign(['source_file'])
      })
      await knex.schema.alterTable('nivaro_help_video_versions', (t) => {
        t.uuid('source_file').notNullable().alter()
      })
      await knex.schema.alterTable('nivaro_help_video_versions', (t) => {
        t.foreign('source_file').references('id').inTable('nivaro_files')
      })
      await knex.schema.alterTable('nivaro_help_video_versions', (t) => {
        t.dropColumn('files_removed_at')
      })
    }
  }
  if (await knex.schema.hasTable('nivaro_help_video_pages')) {
    for (const c of ['labels_at', 'labels']) {
      if (await knex.schema.hasColumn('nivaro_help_video_pages', c)) {
        await knex.schema.alterTable('nivaro_help_video_pages', (t) => t.dropColumn(c))
      }
    }
  }
  if (await knex.schema.hasTable('nivaro_help_videos')) {
    for (const c of ['stale_dismissed_at', 'stale_reason']) {
      if (await knex.schema.hasColumn('nivaro_help_videos', c)) {
        await knex.schema.alterTable('nivaro_help_videos', (t) => t.dropColumn(c))
      }
    }
  }
}
