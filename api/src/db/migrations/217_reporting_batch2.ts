import type { Knex } from 'knex'

/**
 * Reporting batch 2: widget annotations, report folders, scheduled snapshots,
 * and PDF-attached subscription digests.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_report_annotations', (t) => {
    t.increments('id')
    t.uuid('report')
      .notNullable()
      .references('id')
      .inTable('nivaro_report_defs')
      .onDelete('CASCADE')
      .onUpdate('NO ACTION')
    // Widgets bulk-replace, so no FK — a stale annotation just stops rendering.
    t.uuid('widget').notNullable()
    t.string('note', 500).notNullable()
    // Bucket key ("2026-03" / "2026-03-14") for chart markers; null = widget-level note.
    t.string('anchor_date', 20).nullable()
    t.uuid('created_by').nullable()
    t.dateTime('created_at').defaultTo(knex.fn.now())
  })

  const addCol = async (table: string, col: string, cb: (t: Knex.AlterTableBuilder) => void) => {
    if (!(await knex.schema.hasColumn(table, col))) {
      await knex.schema.alterTable(table, cb)
    }
  }
  await addCol('nivaro_report_defs', 'folder', (t) => t.string('folder', 100).nullable())
  await addCol('nivaro_report_defs', 'snapshot_schedule', (t) =>
    t.string('snapshot_schedule', 20).nullable()
  )
  await addCol('nivaro_report_subscriptions', 'attach_pdf', (t) =>
    t.boolean('attach_pdf').notNullable().defaultTo(false)
  )
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_report_annotations')
  const dropCol = async (table: string, col: string) => {
    if (await knex.schema.hasColumn(table, col)) {
      await knex.schema.alterTable(table, (t) => t.dropColumn(col))
    }
  }
  await dropCol('nivaro_report_defs', 'folder')
  await dropCol('nivaro_report_defs', 'snapshot_schedule')
  await dropCol('nivaro_report_subscriptions', 'attach_pdf')
}
