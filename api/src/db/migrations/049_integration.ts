import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_erp_submissions', (t) => {
    t.increments('id')
    t.string('collection', 100).notNullable()
    t.string('item', 100).notNullable()
    t.integer('external_api').notNullable() // nivaro_external_apis uses an int PK
    t.foreign('external_api')
      .references('id')
      .inTable('nivaro_external_apis')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.string('external_ref', 255).nullable()
    t.string('status', 20).notNullable().defaultTo('submitted')
    t.integer('attempts').notNullable().defaultTo(0)
    t.specificType('last_error', 'nvarchar(max)').nullable()
    t.specificType('payload', 'nvarchar(max)').nullable()
    t.datetime('created_at').defaultTo(knex.fn.now())
    t.datetime('updated_at').defaultTo(knex.fn.now())
  })

  await knex.schema.createTable('nivaro_sync_jobs', (t) => {
    t.increments('id')
    t.string('name', 255).notNullable()
    t.string('direction', 10).notNullable() // 'inbound' | 'outbound'
    t.integer('external_api').notNullable()
    t.foreign('external_api')
      .references('id')
      .inTable('nivaro_external_apis')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.string('collection', 100).notNullable()
    t.string('endpoint_path', 500).notNullable()
    t.specificType('field_mapping', 'nvarchar(max)').notNullable()
    t.string('conflict_strategy', 20).notNullable().defaultTo('newest-wins')
    t.string('schedule', 100).nullable()
    t.string('id_field', 100).notNullable().defaultTo('id')
    t.string('external_id_field', 100).nullable()
    t.boolean('is_active').notNullable().defaultTo(true)
    t.datetime('last_run_at').nullable()
    t.string('last_run_status', 20).nullable()
    t.specificType('last_run_stats', 'nvarchar(max)').nullable()
    t.uuid('created_by').notNullable()
    t.foreign('created_by')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.datetime('created_at').defaultTo(knex.fn.now())
    t.datetime('updated_at').defaultTo(knex.fn.now())
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_sync_jobs')
  await knex.schema.dropTableIfExists('nivaro_erp_submissions')
}
