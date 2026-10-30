import type { Knex } from 'knex'

/**
 * Field comments (#3232): a record comment may be about ONE field of the record.
 *
 *   nivaro_comments.field        nvarchar(255) NULL — the field the comment was left on
 *                                (null = a comment on the whole record, as before)
 *   nivaro_comments.resolved_at  datetime NULL — a field comment someone marked done; the
 *                                field's badge counts only open ones
 *   nivaro_comments.resolved_by  uuid NULL — who resolved it (no FK, like deleted_by)
 *
 * All nullable and additive (metadata-only on SQL Server); guarded so a re-run is a no-op.
 * The comments routes probe for `field` and keep working without it.
 */
const TABLE = 'nivaro_comments'

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (!(await knex.schema.hasColumn(TABLE, 'field'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.string('field', 255).nullable()
    })
  }
  if (!(await knex.schema.hasColumn(TABLE, 'resolved_at'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.datetime('resolved_at').nullable()
    })
  }
  if (!(await knex.schema.hasColumn(TABLE, 'resolved_by'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.uuid('resolved_by').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  for (const col of ['resolved_by', 'resolved_at', 'field'] as const) {
    if (await knex.schema.hasColumn(TABLE, col)) {
      await knex.schema.alterTable(TABLE, (t) => {
        t.dropColumn(col)
      })
    }
  }
}
