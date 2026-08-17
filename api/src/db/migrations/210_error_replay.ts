import type { Knex } from 'knex'

/**
 * Replay-on-error.
 *
 * Support's actual question about a client error is "what did they DO" —
 * the stack answers what broke, never the path there. Two pieces:
 *
 *   - `nivaro_settings.error_replay_enabled` — a rolling in-memory rrweb
 *     buffer (last ~60s, inputs masked, nothing uploaded) that is flushed to
 *     the server ONLY when an error is reported, landing as a short
 *     recording labelled app='error-clip'. Distinct from full session
 *     recording: that streams everything continuously; this uploads nothing
 *     until something breaks. Default OFF — silently keeping a buffer, even
 *     in-memory and masked, is a decision the operator makes.
 *
 *   - `nivaro_issues.recording_id` + `recording_offset_ms` — the issue row
 *     links straight to the replay at the error moment. Populated by both
 *     modes: a live full recording links with its offset; buffer mode links
 *     the uploaded clip.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'error_replay_enabled'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.boolean('error_replay_enabled').notNullable().defaultTo(false)
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_issues', 'recording_id'))) {
    await knex.schema.alterTable('nivaro_issues', (t) => {
      t.string('recording_id', 36).nullable()
      t.integer('recording_offset_ms').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'error_replay_enabled')) {
    await knex.schema.alterTable('nivaro_settings', (t) => t.dropColumn('error_replay_enabled'))
  }
  if (await knex.schema.hasColumn('nivaro_issues', 'recording_id')) {
    await knex.schema.alterTable('nivaro_issues', (t) => {
      t.dropColumn('recording_id')
      t.dropColumn('recording_offset_ms')
    })
  }
}
