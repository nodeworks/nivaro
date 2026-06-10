import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_webhook_deliveries', (t) => {
    t.increments('id')
    t.integer('webhook').notNullable()
    t.foreign('webhook')
      .references('id')
      .inTable('nivaro_webhooks')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.string('event', 100).notNullable()
    t.integer('status_code').nullable()
    t.specificType('request_body', 'nvarchar(max)').nullable()
    t.specificType('response_body', 'nvarchar(max)').nullable()
    t.integer('latency_ms').nullable()
    t.boolean('success').notNullable().defaultTo(false)
    t.integer('attempt').notNullable().defaultTo(1)
    t.datetime('created_at').defaultTo(knex.fn.now())
  })

  await knex.schema.alterTable('nivaro_webhooks', (t) => {
    t.string('signing_secret', 255).nullable()
  })

  await knex.schema.createTable('nivaro_persisted_queries', (t) => {
    t.increments('id')
    t.string('hash', 64).notNullable()
    t.string('name', 255).notNullable()
    t.specificType('query', 'nvarchar(max)').notNullable()
    t.uuid('created_by').notNullable()
    t.foreign('created_by')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.datetime('created_at').defaultTo(knex.fn.now())
  })
  await knex.raw(
    'ALTER TABLE nivaro_persisted_queries ADD CONSTRAINT uq_nivaro_persisted_queries_hash UNIQUE (hash)'
  )

  await knex.schema.createTable('nivaro_flow_versions', (t) => {
    t.increments('id')
    t.uuid('flow').notNullable() // nivaro_flows uses a uniqueidentifier PK
    t.foreign('flow')
      .references('id')
      .inTable('nivaro_flows')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.integer('version').notNullable()
    t.specificType('definition', 'nvarchar(max)').notNullable()
    t.uuid('created_by').notNullable()
    t.foreign('created_by')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.datetime('created_at').defaultTo(knex.fn.now())
  })
  await knex.raw(
    'ALTER TABLE nivaro_flow_versions ADD CONSTRAINT uq_nivaro_flow_versions UNIQUE (flow, version)'
  )
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_flow_versions')
  await knex.schema.dropTableIfExists('nivaro_persisted_queries')
  await knex.schema.alterTable('nivaro_webhooks', (t) => {
    t.dropColumn('signing_secret')
  })
  await knex.schema.dropTableIfExists('nivaro_webhook_deliveries')
}
