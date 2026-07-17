import type { Knex } from 'knex'

// The o2m revision endpoints join nivaro_revisions.activity → nivaro_activity.id
// and filter activity by (collection, action, timestamp). With the legacy
// history import (6.5M revisions / 7.8M activity rows) both sides were
// unindexed for that shape, so JSON_VALUE candidate filtering scanned the
// whole revisions table and timed out at 15s.

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_revisions', (t) => {
    t.index(['activity'], 'ix_nivaro_revisions_activity')
  })
  await knex.raw(`
    CREATE INDEX ix_nivaro_activity_collection_action_ts
    ON nivaro_activity (collection, action, timestamp)
    INCLUDE (item, [user])
  `)
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_revisions', (t) => {
    t.dropIndex(['activity'], 'ix_nivaro_revisions_activity')
  })
  await knex.raw('DROP INDEX ix_nivaro_activity_collection_action_ts ON nivaro_activity')
}
