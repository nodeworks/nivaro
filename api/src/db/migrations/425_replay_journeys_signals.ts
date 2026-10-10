import type { Knex } from 'knex'

/**
 * Session replay backlog batch (migration 425):
 *
 * - nivaro_admin_journeys.app (#1391) — which front end the page ping came
 *   from ('admin', or the portal's app label). NULL = a row written before
 *   the column, which was always the admin.
 * - nivaro_tasks.replay_recording_id / replay_offset_ms (#1377) — the
 *   'Watch what they saw' link on a support request: the requester's own
 *   recording (a support clip, or the live recording) and where in it they
 *   asked. NULL = no replay was on.
 */
export async function up(knex: Knex): Promise<void> {
  if (
    (await knex.schema.hasTable('nivaro_admin_journeys')) &&
    !(await knex.schema.hasColumn('nivaro_admin_journeys', 'app'))
  ) {
    await knex.schema.alterTable('nivaro_admin_journeys', (t) => {
      t.string('app', 50).nullable()
    })
  }
  if (await knex.schema.hasTable('nivaro_tasks')) {
    if (!(await knex.schema.hasColumn('nivaro_tasks', 'replay_recording_id'))) {
      await knex.schema.alterTable('nivaro_tasks', (t) => {
        t.string('replay_recording_id', 36).nullable()
      })
    }
    if (!(await knex.schema.hasColumn('nivaro_tasks', 'replay_offset_ms'))) {
      await knex.schema.alterTable('nivaro_tasks', (t) => {
        t.integer('replay_offset_ms').nullable()
      })
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const col of ['replay_offset_ms', 'replay_recording_id']) {
    if (await knex.schema.hasColumn('nivaro_tasks', col)) {
      await knex.schema.alterTable('nivaro_tasks', (t) => {
        t.dropColumn(col)
      })
    }
  }
  if (await knex.schema.hasColumn('nivaro_admin_journeys', 'app')) {
    await knex.schema.alterTable('nivaro_admin_journeys', (t) => {
      t.dropColumn('app')
    })
  }
}
