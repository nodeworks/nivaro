import type { Knex } from 'knex'
import { isMssql, utcNow } from '../dialect.js'

/**
 * Migration 427 — realtime event pipeline (server side).
 *
 * #1673 Durable event journal:
 *  - nivaro_event_journal: every journaled realtime event (the same minimal
 *    payload the Redis journal holds — collection, record id, action and the
 *    NAMES of the fields written, never a value), kept 24 hours. A client
 *    whose cursor is older than the 15-minute Redis window replays from here
 *    instead of reloading everything.
 *
 * #1875 Raw writers announce changes:
 *  - nivaro_raw_writes: an inbox a stored procedure or a script outside the API
 *    writes to after a set-based change (collection + record ids). The API
 *    drains it every few seconds and broadcasts each change, so open pages
 *    refresh. Rows are deleted as they are read.
 *  - nivaro_announce_writes (SQL Server only): a procedure that fills the inbox
 *    from a comma list of ids, so a procedure needs one EXEC line.
 *
 * Idempotent: every step checks before it creates. Writers probe the tables,
 * so a database behind this migration keeps working without them.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_event_journal'))) {
    await knex.schema.createTable('nivaro_event_journal', (t) => {
      t.bigIncrements('id').primary()
      /** The Redis sequence number the event was emitted with (the client cursor). */
      t.bigInteger('seq').notNullable()
      /** Socket room ("collection:workflows"). */
      t.string('room', 300).notNullable()
      t.string('event', 60).notNullable()
      t.string('collection', 255).nullable()
      t.string('item', 255).nullable()
      t.string('action', 10).nullable()
      /** JSON array of field NAMES. */
      t.string('changed_fields', 2000).nullable()
      /** JSON object of other small, value-free keys (source, bulk, probe). */
      t.string('extra', 500).nullable()
      t.dateTime('at').notNullable().defaultTo(utcNow(knex))
      t.index(['seq'], 'ix_event_journal_seq')
      t.index(['at'], 'ix_event_journal_at')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_raw_writes'))) {
    await knex.schema.createTable('nivaro_raw_writes', (t) => {
      t.bigIncrements('id').primary()
      t.string('collection', 255).notNullable()
      /** NULL = "records in this collection changed" (no id list). */
      t.string('item', 255).nullable()
      t.string('action', 10).nullable()
      /** Comma list of field names. */
      t.string('changed_fields', 2000).nullable()
      /** Who announced it ("procedure:reforecast", "script:fix-lines"). */
      t.string('source', 120).nullable()
      t.dateTime('created_at').notNullable().defaultTo(utcNow(knex))
    })
  }

  if (isMssql(knex)) {
    await knex.raw(`
CREATE OR ALTER PROCEDURE nivaro_announce_writes
  @Collection NVARCHAR(255),
  @Ids NVARCHAR(MAX) = NULL,
  @Action NVARCHAR(10) = 'update',
  @Fields NVARCHAR(2000) = NULL,
  @Source NVARCHAR(120) = NULL
AS
BEGIN
  SET NOCOUNT ON;
  IF @Ids IS NULL OR LTRIM(RTRIM(@Ids)) = ''
    INSERT INTO nivaro_raw_writes (collection, item, action, changed_fields, source, created_at)
    VALUES (@Collection, NULL, @Action, @Fields, @Source, GETUTCDATE());
  ELSE
    INSERT INTO nivaro_raw_writes (collection, item, action, changed_fields, source, created_at)
    SELECT DISTINCT @Collection, LTRIM(RTRIM(value)), @Action, @Fields, @Source, GETUTCDATE()
    FROM STRING_SPLIT(@Ids, ',')
    WHERE LTRIM(RTRIM(value)) <> '';
END
`)
  }
}

export async function down(knex: Knex): Promise<void> {
  if (isMssql(knex)) {
    await knex.raw(
      "IF OBJECT_ID('nivaro_announce_writes', 'P') IS NOT NULL DROP PROCEDURE nivaro_announce_writes"
    )
  }
  await knex.schema.dropTableIfExists('nivaro_raw_writes')
  await knex.schema.dropTableIfExists('nivaro_event_journal')
}
