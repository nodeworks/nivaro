import type { Knex } from 'knex'

/**
 * Client environment metadata per session recording — OS/browser (via user
 * agent), screen and viewport size, DPR, language, timezone. JSON text,
 * captured once at /session-recordings/start.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_session_recordings', 'meta'))) {
    await knex.schema.alterTable('nivaro_session_recordings', (t) => {
      t.text('meta').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_session_recordings', 'meta')) {
    await knex.schema.alterTable('nivaro_session_recordings', (t) => {
      t.dropColumn('meta')
    })
  }
}
