import type { Knex } from 'knex'

/**
 * Session recordings capture masquerade context: when a recording starts under
 * an nvm_ masquerade token, the ISSUING ADMIN's id is stamped so the replay
 * list can say "recorded while <admin> was masquerading as this user".
 * NULL = a normal session (or a row from before this column existed).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_session_recordings', 'masquerade_admin'))) {
    await knex.schema.alterTable('nivaro_session_recordings', (t) => {
      t.uuid('masquerade_admin').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_session_recordings', 'masquerade_admin')) {
    await knex.schema.alterTable('nivaro_session_recordings', (t) => {
      t.dropColumn('masquerade_admin')
    })
  }
}
