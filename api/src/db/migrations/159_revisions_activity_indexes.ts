import type { Knex } from 'knex'

// The o2m revision endpoints join nivaro_revisions.activity → nivaro_activity.id
// and filter activity by (collection, action, timestamp). With the legacy
// history import (6.5M revisions / 7.8M activity rows) both sides were
// unindexed for that shape, so JSON_VALUE candidate filtering scanned the
// whole revisions table and timed out at 15s.
//
// Existence-guarded: on large databases these builds exceed the pool's request
// timeout, so ops may pre-create them out-of-band; the migration then just
// records itself.

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nivaro_revisions_activity')
    CREATE INDEX ix_nivaro_revisions_activity ON nivaro_revisions (activity)
  `)
  await knex.raw(`
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nivaro_activity_collection_action_ts')
    CREATE INDEX ix_nivaro_activity_collection_action_ts
    ON nivaro_activity (collection, action, timestamp)
    INCLUDE (item, [user])
  `)
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nivaro_revisions_activity')
    DROP INDEX ix_nivaro_revisions_activity ON nivaro_revisions
  `)
  await knex.raw(`
    IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nivaro_activity_collection_action_ts')
    DROP INDEX ix_nivaro_activity_collection_action_ts ON nivaro_activity
  `)
}
