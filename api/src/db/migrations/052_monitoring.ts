import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_api_logs', (t) => {
    t.bigIncrements('id')
    t.string('method', 10).notNullable()
    t.string('path', 500).notNullable()
    t.integer('status').notNullable()
    t.integer('latency_ms').notNullable()
    t.string('user', 100).nullable() // no FK — high write volume
    t.string('collection', 100).nullable()
    t.datetime('created_at').defaultTo(knex.fn.now())
  })
  await knex.raw('CREATE INDEX idx_nivaro_api_logs_created_at ON nivaro_api_logs (created_at)')

  await knex.schema.createTable('nivaro_issues', (t) => {
    t.increments('id')
    t.string('collection', 100).nullable()
    t.string('item', 100).nullable()
    t.string('title', 500).notNullable()
    t.string('severity', 20).notNullable().defaultTo('medium')
    t.string('status', 20).notNullable().defaultTo('open')
    t.uuid('assigned_to').nullable()
    t.foreign('assigned_to')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.uuid('raised_by').notNullable()
    t.foreign('raised_by')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.specificType('resolution_notes', 'nvarchar(max)').nullable()
    t.datetime('created_at').defaultTo(knex.fn.now())
    t.datetime('updated_at').defaultTo(knex.fn.now())
  })

  await knex.schema.createTable('nivaro_dq_rules', (t) => {
    t.increments('id')
    t.string('collection', 100).notNullable()
    t.string('name', 255).notNullable()
    t.string('rule_type', 20).notNullable()
    t.string('field', 100).nullable()
    t.specificType('config', 'nvarchar(max)').nullable()
    t.string('severity', 20).notNullable().defaultTo('medium')
    t.boolean('is_active').notNullable().defaultTo(true)
    t.datetime('created_at').defaultTo(knex.fn.now())
  })

  await knex.schema.createTable('nivaro_dq_runs', (t) => {
    t.increments('id')
    t.string('collection', 100).notNullable()
    t.datetime('started_at').defaultTo(knex.fn.now())
    t.datetime('finished_at').nullable()
    t.integer('total_records').nullable()
    t.integer('failed_records').nullable()
    t.specificType('results', 'nvarchar(max)').nullable()
    t.uuid('created_by').notNullable()
    t.foreign('created_by')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_dq_runs')
  await knex.schema.dropTableIfExists('nivaro_dq_rules')
  await knex.schema.dropTableIfExists('nivaro_issues')
  await knex.schema.dropTableIfExists('nivaro_api_logs')
}
