import type { Knex } from 'knex'

/**
 * Reverting an import run (or one record of it).
 *
 *   nivaro_import_run_items.reverted_at   when the item was put back
 *   nivaro_import_run_items.revert_note   what was done, or why it was left
 *                                         alone ('changed since the import')
 *   nivaro_import_queue.reverted_at/_by   the newest revert of the run
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_import_run_items')) {
    if (!(await knex.schema.hasColumn('nivaro_import_run_items', 'reverted_at'))) {
      await knex.schema.alterTable('nivaro_import_run_items', (t) => {
        t.dateTime('reverted_at').nullable()
        t.string('revert_note', 500).nullable()
      })
    }
  }
  if (await knex.schema.hasTable('nivaro_import_queue')) {
    if (!(await knex.schema.hasColumn('nivaro_import_queue', 'reverted_at'))) {
      await knex.schema.alterTable('nivaro_import_queue', (t) => {
        t.dateTime('reverted_at').nullable()
        // A bare uuid, no FK: a deleted user must never block a queue write.
        t.uuid('reverted_by').nullable()
      })
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_import_run_items')) {
    for (const col of ['reverted_at', 'revert_note']) {
      if (await knex.schema.hasColumn('nivaro_import_run_items', col)) {
        await knex.schema.alterTable('nivaro_import_run_items', (t) => {
          t.dropColumn(col)
        })
      }
    }
  }
  if (await knex.schema.hasTable('nivaro_import_queue')) {
    for (const col of ['reverted_at', 'reverted_by']) {
      if (await knex.schema.hasColumn('nivaro_import_queue', col)) {
        await knex.schema.alterTable('nivaro_import_queue', (t) => {
          t.dropColumn(col)
        })
      }
    }
  }
}
