import type { Knex } from 'knex'

// Session replay index (#1374, #1372): what each recording touched, written
// at upload by services/session-replay-index.ts — route patterns, record ids
// opened (collection/id), the data-field NAMES of inputs focused or typed into
// (never values) and the selectors of elements clicked or typed into. One row
// per (recording, kind, key) with the first and last epoch-ms it was seen.
//
// Rows go with their recording: ON DELETE CASCADE from
// nivaro_session_recordings, so the retention pass and the Delete button
// purge them too. (One cascade path — users → recordings → index — the same
// shape nivaro_session_events already has, so SQL Server accepts it.)
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_replay_index'))) {
    await knex.schema.createTable('nivaro_replay_index', (t) => {
      t.increments('id')
      t.uuid('recording')
        .notNullable()
        .references('id')
        .inTable('nivaro_session_recordings')
        .onDelete('CASCADE')
      // 'route' | 'record' | 'field' | 'selector'
      t.string('kind', 16).notNullable()
      t.string('key', 255).notNullable()
      t.bigInteger('first_ms').notNullable()
      t.bigInteger('last_ms').notNullable()
      t.unique(['recording', 'kind', 'key'], { indexName: 'ux_replay_index_entry' })
      t.index(['kind', 'key'], 'ix_replay_index_lookup')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_replay_index')
}
