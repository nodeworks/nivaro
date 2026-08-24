import type { Knex } from 'knex'

// Storage runway (#291/#155): one row per day of database + uploads size and
// the biggest tables, written by the storage-snapshot cron. The runway page
// fits a line over these to project a disk-full date — honest "collecting
// data" until enough days exist.
export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasTable('nivaro_storage_snapshots')
  if (!has) {
    await knex.schema.createTable('nivaro_storage_snapshots', (t) => {
      t.increments('id')
      t.date('snapshot_date').notNullable().unique()
      t.bigInteger('db_mb').nullable()
      t.bigInteger('uploads_mb').nullable()
      t.text('top_tables').nullable() // JSON: [{table, rows, mb}]
      t.datetime('created_at').notNullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasTable('nivaro_storage_snapshots')
  if (has) await knex.schema.dropTable('nivaro_storage_snapshots')
}
