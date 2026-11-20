import type { Knex } from 'knex'
import { longText } from '../portable-ddl.js'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queue_sources', (t) => {
    // JSON: Record<extraFieldPath, ColumnFormatConfig> — per-column display
    // format (datetime/number/boolean). Applied client-side at render time
    // only; raw values stay raw in the cache and API responses.
    longText(t, knex, 'column_formats').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queue_sources', (t) => {
    t.dropColumn('column_formats')
  })
}
