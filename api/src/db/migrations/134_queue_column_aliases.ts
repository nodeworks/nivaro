import type { Knex } from 'knex'
import { longText } from '../portable-ddl.js'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queues', (t) => {
    // JSON: Record<columnKey, label> — queue-level display aliases for table
    // columns (base keys like 'label'/'state'/'owners' and 'extra.<path>' keys).
    longText(t, knex, 'column_aliases').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_queues', (t) => {
    t.dropColumn('column_aliases')
  })
}
