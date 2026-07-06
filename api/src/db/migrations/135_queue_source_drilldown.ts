import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queue_sources', (t) => {
    // JSON: Record<extraFieldPath, { enabled?: boolean; layout_id?: number | null }>
    // Per-column drill-down config; absent path = enabled by default for
    // relation paths, using the target collection's active detail layout.
    t.specificType('drilldown', 'nvarchar(max)').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queue_sources', (t) => {
    t.dropColumn('drilldown')
  })
}
