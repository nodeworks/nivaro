import type { Knex } from 'knex'

/**
 * Warehouse material forecast: current month + 12.
 *
 * warehouse_inventory carried month_1..month_12 from the legacy EFP import.
 * The forecast manager view shows the actual current month plus twelve ahead
 * (thirteen columns, matching the Forecast Master workbook), so month_13 is
 * added; notes and ordered_by come across from the workbook layout too.
 *
 * History lives in warehouse_forecast_snapshots — one row per (month,
 * warehouse, cifa), written by the monthly cron before it shifts the rolling
 * window left, and on demand from the page's "Snapshot now". Cell-level audit
 * goes to warehouse_forecast_edits (who changed which field, old → new).
 */

export async function up(knex: Knex): Promise<void> {
  // Deployment-specific: warehouse_inventory is an imported legacy business
  // table, not part of the base schema — a fresh install has no such table
  // and this whole migration must be a no-op there.
  if (!(await knex.schema.hasTable('warehouse_inventory'))) return
  const addCol = async (col: string, cb: (t: Knex.AlterTableBuilder) => void) => {
    if (!(await knex.schema.hasColumn('warehouse_inventory', col))) {
      await knex.schema.alterTable('warehouse_inventory', cb)
    }
  }
  await addCol('month_13', (t) => t.decimal('month_13', 12, 2).defaultTo(0))
  await addCol('notes', (t) => t.string('notes', 1000))
  await addCol('ordered_by', (t) => t.string('ordered_by', 255))

  if (!(await knex.schema.hasTable('warehouse_forecast_snapshots'))) {
    await knex.schema.createTable('warehouse_forecast_snapshots', (t) => {
      t.increments('id').primary()
      // Always the 1st of the month the snapshot represents.
      t.date('snapshot_month').notNullable()
      t.integer('warehouse').notNullable()
      t.integer('cifa').notNullable()
      t.boolean('forecasted').notNullable().defaultTo(false)
      for (let m = 1; m <= 13; m++) t.decimal(`month_${m}`, 12, 2).defaultTo(0)
      t.integer('on_hand_quantity').defaultTo(0)
      t.decimal('open_po_qty', 12, 2).defaultTo(0)
      t.decimal('backordered_qty', 12, 2).defaultTo(0)
      t.integer('open_sales_order_qty').defaultTo(0)
      t.decimal('current_month_usage', 12, 2).defaultTo(0)
      t.decimal('price', 12, 2).defaultTo(0)
      t.string('status', 50)
      t.string('notes', 1000)
      t.string('ordered_by', 255)
      t.timestamp('created').defaultTo(knex.fn.now())
      t.unique(['snapshot_month', 'warehouse', 'cifa'])
      t.index(['warehouse', 'cifa'])
    })
  }

  if (!(await knex.schema.hasTable('warehouse_forecast_edits'))) {
    await knex.schema.createTable('warehouse_forecast_edits', (t) => {
      t.increments('id').primary()
      t.integer('warehouse_inventory').notNullable().index()
      t.string('field', 50).notNullable()
      t.string('old_value', 100)
      t.string('new_value', 100)
      t.uuid('user')
      t.timestamp('created').defaultTo(knex.fn.now())
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('warehouse_forecast_edits')
  await knex.schema.dropTableIfExists('warehouse_forecast_snapshots')
  for (const col of ['month_13', 'notes', 'ordered_by']) {
    if (await knex.schema.hasColumn('warehouse_inventory', col)) {
      await knex.schema.alterTable('warehouse_inventory', (t) => t.dropColumn(col))
    }
  }
}
