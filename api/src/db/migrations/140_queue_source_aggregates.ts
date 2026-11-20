import type { Knex } from 'knex'
import { longText } from '../portable-ddl.js'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queue_sources', (t) => {
    // JSON: Record<extraFieldPath, 'sum'|'avg'|'min'|'max'|'count'> — aggregate
    // the relation's numeric leaf per row instead of listing values. Null = no
    // aggregation. CACHE-AFFECTING (forces teardown + rebuild on change).
    longText(t, knex, 'aggregates').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queue_sources', (t) => {
    t.dropColumn('aggregates')
  })
}
