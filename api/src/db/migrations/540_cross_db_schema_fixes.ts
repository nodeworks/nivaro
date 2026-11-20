import type { Knex } from 'knex'
import { dialectOf } from '../portable-ddl.js'
import { rawRows } from '../raw-rows.js'

/**
 * Three schema fixes found by the five-database work (SQL Server, Postgres, MySQL, MariaDB,
 * SQLite). Each step is guarded and additive; on a database where it already holds, it does
 * nothing.
 *
 * 1. MySQL / MariaDB: `nivaro_layout_versions.layout_id` loses the ON DELETE CASCADE foreign key
 *    migration 211 gave it — migration 456 removed it on SQL Server, Postgres and SQLite only, so
 *    deleting a layout there threw its version history away.
 *
 * 2. MySQL / MariaDB: `ux_integration_signal_rows_open` is UNIQUE (signal, row_key) over OPEN rows
 *    (cleared_at IS NULL) on SQL Server, Postgres and SQLite — a filtered / partial index. MySQL
 *    has no filtered index, so migration 348 built a plain unique and a cleared problem's key could
 *    never open again. Here a stored generated column `open_marker` is 1 while the row is open and
 *    NULL once cleared, and the unique index covers (signal, row_key, open_marker): unique indexes
 *    let any number of NULLs through, so cleared rows never collide and open rows do. No app code
 *    names the column (every read lists its columns, writes never set it).
 *
 * 3. Every engine: the legacy `user_presence` table (Directus-era; existing environments have it)
 *    is created on a fresh install, where no migration ever made it and `/api/presence/online`
 *    answered 500. Columns are the ones the API and the apps write (plugins/socketio.ts,
 *    admin lib/chat-presence.ts, efp-new features/presence.ts) and migrations 200 / 202 / 203 add:
 *    one row per person (UNIQUE user_id). No foreign key: presence is advisory and must never stop
 *    a user from being removed. Skipped when the table exists (its columns are left as they are).
 */
export async function up(knex: Knex): Promise<void> {
  const d = dialectOf(knex)

  // MySQL and MariaDB (dialect 'mysql') take the same statements here.
  if (d === 'mysql') {
    // 1. Drop the cascade FK on nivaro_layout_versions.layout_id (name looked up, not assumed).
    if (await knex.schema.hasTable('nivaro_layout_versions')) {
      const fks = rawRows<{ name: string }>(
        await knex.raw(
          `SELECT DISTINCT CONSTRAINT_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nivaro_layout_versions'
              AND COLUMN_NAME = 'layout_id' AND REFERENCED_TABLE_NAME IS NOT NULL`
        )
      )
      for (const { name } of fks)
        await knex.raw('ALTER TABLE ?? DROP FOREIGN KEY ??', ['nivaro_layout_versions', name])
    }

    // 2. Unique over open rows only.
    const table = 'nivaro_integration_signal_rows'
    if (await knex.schema.hasTable(table)) {
      if (!(await knex.schema.hasColumn(table, 'open_marker'))) {
        // Same statement on MySQL 8 and MariaDB 10.11+ (STORED = MariaDB's PERSISTENT).
        await knex.raw(
          `ALTER TABLE ?? ADD COLUMN open_marker TINYINT GENERATED ALWAYS AS (CASE WHEN cleared_at IS NULL THEN 1 ELSE NULL END) STORED`,
          [table]
        )
      }
      const cols = rawRows<{ col: string }>(
        await knex.raw(
          `SELECT COLUMN_NAME AS col FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = 'ux_integration_signal_rows_open'
            ORDER BY SEQ_IN_INDEX`,
          [table]
        )
      ).map((r) => String(r.col).toLowerCase())
      if (cols.join(',') !== 'signal,row_key,open_marker') {
        const drop = cols.length ? 'DROP INDEX ux_integration_signal_rows_open, ' : ''
        await knex.raw(
          `ALTER TABLE ?? ${drop}ADD UNIQUE INDEX ux_integration_signal_rows_open (\`signal\`, row_key, open_marker)`,
          [table]
        )
      }
    }
  }

  // 3. user_presence on every engine.
  if (!(await knex.schema.hasTable('user_presence'))) {
    await knex.schema.createTable('user_presence', (t) => {
      t.increments('id')
      t.uuid('user_id').notNullable().unique()
      t.string('display_name', 255).nullable()
      t.string('role_name', 255).nullable()
      t.string('current_path', 255).nullable()
      t.string('typing_room', 255).nullable()
      t.string('app', 50).nullable()
      t.dateTime('last_seen').nullable()
      t.boolean('is_online').notNullable().defaultTo(false)
      t.boolean('is_idle').notNullable().defaultTo(false)
      t.dateTime('last_active').nullable()
      t.index(['last_seen'], 'ix_user_presence_last_seen')
    })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: putting the cascade or the plain unique back would only bring their bugs
  // back, and user_presence may hold live rows (or predate this migration).
}
