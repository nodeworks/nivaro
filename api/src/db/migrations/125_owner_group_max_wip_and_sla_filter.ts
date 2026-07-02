import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_pipeline_owner_groups', (t) => {
    t.integer('max_wip').nullable()
  })
  await knex.schema.alterTable('nivaro_queue_sources', (t) => {
    t.string('sla_filter', 20).nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_pipeline_owner_groups', (t) => {
    t.dropColumn('max_wip')
  })
  await knex.schema.alterTable('nivaro_queue_sources', (t) => {
    t.dropColumn('sla_filter')
  })
}
