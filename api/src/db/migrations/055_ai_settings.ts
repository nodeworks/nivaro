import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  // Per-collection AI feature configuration (content validation + duplicate detection)
  await knex.schema.createTable('nivaro_ai_collection_settings', (t) => {
    t.increments('id')
    t.string('collection', 100).notNullable()
    t.boolean('validation_enabled').notNullable().defaultTo(false)
    t.string('validation_mode', 10).notNullable().defaultTo('soft') // soft = warn, hard = block
    t.specificType('validation_rules', 'nvarchar(max)').nullable() // JSON array of rule strings
    t.boolean('duplicate_detection_enabled').notNullable().defaultTo(false)
    t.float('duplicate_threshold').notNullable().defaultTo(0.85)
    t.datetime('created_at').defaultTo(knex.fn.now())
    t.datetime('updated_at').defaultTo(knex.fn.now())
  })
  await knex.raw(
    'ALTER TABLE nivaro_ai_collection_settings ADD CONSTRAINT uq_nivaro_ai_settings_collection UNIQUE (collection)'
  )

  // Anomaly detection support on the existing alert engine
  await knex.schema.alterTable('nivaro_alert_definitions', (t) => {
    t.string('detection_type', 20).notNullable().defaultTo('threshold') // threshold | anomaly
  })
  await knex.schema.alterTable('nivaro_alert_definitions', (t) => {
    t.float('sensitivity').nullable() // stddev multiplier for anomaly detection
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_alert_definitions', (t) => {
    t.dropColumn('sensitivity')
  })
  await knex.schema.alterTable('nivaro_alert_definitions', (t) => {
    t.dropColumn('detection_type')
  })
  await knex.schema.dropTableIfExists('nivaro_ai_collection_settings')
}
