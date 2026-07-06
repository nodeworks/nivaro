import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queues', (t) => {
    // JSON: Record<columnKey, label> — queue-level display aliases for table
    // columns (base keys like 'label'/'state'/'owners' and 'extra.<path>' keys).
    t.specificType('column_aliases', 'nvarchar(max)').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queues', (t) => {
    t.dropColumn('column_aliases')
  })
}
