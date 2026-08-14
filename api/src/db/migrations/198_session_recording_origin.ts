import type { Knex } from 'knex'

/**
 * Which host a session was recorded on.
 *
 * A replay list that does not say whether a session happened on local,
 * staging or production leaves the reader guessing at the one fact that
 * decides whether the recording explains a production report or a developer
 * poking about — and the generated Playwright script targets an environment,
 * so it matters twice.
 *
 * NULL on historical rows: unknown, shown as such rather than assumed.
 */
export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_session_recordings', 'origin')
  if (!has) {
    await knex.schema.alterTable('nivaro_session_recordings', (t) => {
      t.string('origin', 255).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_session_recordings', 'origin')
  if (has) {
    await knex.schema.alterTable('nivaro_session_recordings', (t) => {
      t.dropColumn('origin')
    })
  }
}
