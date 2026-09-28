import type { Knex } from 'knex'

/**
 * What an import run did, kept so it can be read afterwards.
 *
 * Until now a run kept a 4,000-character text log. An items-service import
 * knows far more: which records it created, which it changed (field, before,
 * after), which file rows it left out and why, which reference values matched
 * nothing, and how long each phase took.
 *
 *   nivaro_import_queue.report   JSON — counts, phases, unmatched values, notes
 *   nivaro_import_queue.ran_via  what executed: 'procedure:<name>', 'service',
 *                                a processor key, or 'load'. The definition
 *                                may change later; the run keeps what it ran.
 *   nivaro_import_run_items      one row per record the run touched or file
 *                                row it left out
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_import_queue')) {
    if (!(await knex.schema.hasColumn('nivaro_import_queue', 'report'))) {
      await knex.schema.alterTable('nivaro_import_queue', (t) => {
        t.text('report').nullable()
      })
    }
    if (!(await knex.schema.hasColumn('nivaro_import_queue', 'ran_via'))) {
      await knex.schema.alterTable('nivaro_import_queue', (t) => {
        t.string('ran_via', 160).nullable()
      })
    }
  }
  if (!(await knex.schema.hasTable('nivaro_import_run_items'))) {
    await knex.schema.createTable('nivaro_import_run_items', (t) => {
      t.bigIncrements('id').primary()
      // No FK: deleting a queue row must never wait on its items.
      t.integer('run').notNullable()
      // created | updated | skipped | failed
      t.string('kind', 20).notNullable()
      t.string('collection', 255).nullable()
      t.string('item_id', 255).nullable()
      t.string('label', 500).nullable()
      // 1-based row in the file, header excluded
      t.integer('file_row').nullable()
      t.string('message', 1000).nullable()
      // JSON [{field, from, to}]
      t.text('changes').nullable()
      t.dateTime('created_at').notNullable()
      t.index(['run', 'kind', 'id'], 'ix_import_run_items_run_kind')
      t.index(['created_at'], 'ix_import_run_items_created')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_import_run_items')
  if (await knex.schema.hasTable('nivaro_import_queue')) {
    for (const col of ['report', 'ran_via']) {
      if (await knex.schema.hasColumn('nivaro_import_queue', col)) {
        await knex.schema.alterTable('nivaro_import_queue', (t) => {
          t.dropColumn(col)
        })
      }
    }
  }
}
