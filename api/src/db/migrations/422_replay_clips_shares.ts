import type { Knex } from 'knex'

// Session replay library (#1415): a saved clip is a range of a recording cut
// into a recording of its own (app='clip'), named, described and tagged.
// The library row points at that cut, and the retention purge skips any
// recording a library row points at — the clip outlives its source, which
// purges as usual. Deleting the cut recording removes its library row.
//
// Shareable replay links (#1362): a share names one signed-in person, a
// window of one recording and an expiry. Only a hash of the link's token is
// stored; revoking deletes the row, deleting the recording cascades it.
//
// SQL Server allows one cascade path per table: nivaro_users already
// cascades to nivaro_session_recordings, which cascades to both tables, so
// the people columns (saved_by, user_id, shared_by) are plain ids, not
// foreign keys.
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_replay_clips'))) {
    await knex.schema.createTable('nivaro_replay_clips', (t) => {
      t.uuid('id').primary()
      t.string('name', 200).notNullable()
      t.string('description', 2000).nullable()
      // JSON array of strings.
      t.string('tags', 500).nullable()
      t.uuid('recording')
        .notNullable()
        .references('id')
        .inTable('nivaro_session_recordings')
        .onDelete('CASCADE')
      // Where the clip came from: no key, the source purges with retention.
      t.uuid('source_recording').nullable()
      // The range in the source's own clock (ms from its first event).
      t.integer('from_ms').notNullable()
      t.integer('to_ms').notNullable()
      t.uuid('saved_by').nullable()
      t.datetime('created_at').notNullable()
      t.index(['recording'], 'ix_replay_clips_recording')
      t.index(['created_at'], 'ix_replay_clips_created')
    })
  }
  if (!(await knex.schema.hasTable('nivaro_replay_shares'))) {
    await knex.schema.createTable('nivaro_replay_shares', (t) => {
      t.uuid('id').primary()
      // sha256 (hex) of the link's token — the token itself is never stored.
      t.string('token_hash', 64).notNullable()
      t.uuid('recording')
        .notNullable()
        .references('id')
        .inTable('nivaro_session_recordings')
        .onDelete('CASCADE')
      // The window in the recording's own clock (ms from its first event).
      t.integer('from_ms').notNullable()
      t.integer('to_ms').notNullable()
      // The one person who may open it.
      t.uuid('user_id').notNullable()
      t.uuid('shared_by').nullable()
      t.datetime('expires_at').notNullable()
      t.datetime('created_at').notNullable()
      t.integer('open_count').notNullable().defaultTo(0)
      t.datetime('last_opened_at').nullable()
      t.unique(['token_hash'], { indexName: 'ux_replay_shares_token' })
      t.index(['recording'], 'ix_replay_shares_recording')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_replay_shares')
  await knex.schema.dropTableIfExists('nivaro_replay_clips')
}
