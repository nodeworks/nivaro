import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_workspaces', (t) => {
    t.specificType('quotas', 'nvarchar(max)').nullable() // JSON
  })

  await knex.schema.createTable('nivaro_usage_counters', (t) => {
    t.increments('id')
    t.uuid('workspace').notNullable()
    t.string('metric', 50).notNullable()
    t.string('period', 20).notNullable()
    t.bigInteger('value').notNullable().defaultTo(0)
  })
  await knex.raw(
    'ALTER TABLE nivaro_usage_counters ADD CONSTRAINT uq_nivaro_usage_counters UNIQUE (workspace, metric, period)'
  )
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_usage_counters')
  await knex.schema.alterTable('nivaro_workspaces', (t) => {
    t.dropColumn('quotas')
  })
}
