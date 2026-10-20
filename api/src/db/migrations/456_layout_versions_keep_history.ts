import type { Knex } from 'knex'
import { isMssql } from '../dialect.js'

/**
 * Layout versions survive a layout delete.
 *
 * Migration 211 gave nivaro_layout_versions.layout_id an ON DELETE CASCADE FK,
 * so deleting a layout threw its whole history away with it — the one record
 * of what the layout looked like. The column stays a plain int: layout ids are
 * IDENTITY values an ordinary delete never hands out again, so the versions of
 * a deleted layout keep its id to themselves.
 *
 * Guarded: the constraint name is looked up (knex named it, and a database
 * built another way may differ) and only dropped when present. down() re-adds
 * nothing — the change is additive in effect (no data is touched).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_layout_versions'))) return

  if (isMssql(knex)) {
    const rows = (await knex.raw(
      `SELECT fk.name FROM sys.foreign_keys fk
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
         JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
        WHERE fk.parent_object_id = OBJECT_ID('nivaro_layout_versions') AND c.name = 'layout_id'`
    )) as Array<{ name: string }>
    for (const { name } of rows) {
      await knex.raw('ALTER TABLE ?? DROP CONSTRAINT ??', ['nivaro_layout_versions', name])
    }
    return
  }

  const client = (knex as any)?.client?.config?.client
  if (client === 'pg' || client === 'postgres' || client === 'postgresql') {
    const res = (await knex.raw(
      `SELECT tc.constraint_name AS name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name AND kcu.table_name = tc.table_name
        WHERE tc.table_name = 'nivaro_layout_versions'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'layout_id'`
    )) as { rows: Array<{ name: string }> }
    for (const { name } of res.rows ?? []) {
      await knex.raw('ALTER TABLE ?? DROP CONSTRAINT ??', ['nivaro_layout_versions', name])
    }
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: re-adding the cascade would only bring back the data loss.
}
