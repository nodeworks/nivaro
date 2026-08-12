import type { Knex } from 'knex'

// Metric alert engine (EFP Alert Manager port, generalized) — a metric CATALOG
// (admin-authored definitions backed by custom queries or collection counts),
// user-created RULES (operator + threshold + check frequency), per-user
// SUBSCRIPTIONS (delivery + digest), and a firing/resolved LOG state machine.
// Separate from nivaro_alert_definitions (per-record threshold engine).

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_metric_definitions', (t) => {
    t.increments('id').primary()
    t.string('name', 255).notNullable()
    t.text('description').nullable()
    t.string('metric_key', 100).notNullable().unique()
    t.string('category', 50).notNullable().defaultTo('general')
    t.string('unit', 20).notNullable().defaultTo('count') // percent|dollar|count|days
    t.string('default_operator', 20).notNullable().defaultTo('gte')
    t.decimal('default_threshold', 18, 4).nullable()
    // JSON: {type:'custom_query', slug, value_field?, param_map?: {filterKey: paramName}}
    //     | {type:'collection', collection, conditions?: [...] }  (count via items service)
    t.text('metric_source').notNullable()
    t.text('supported_filters').nullable() // JSON: [{key, label, collection?, value_field?, label_field?}]
    t.string('status', 20).notNullable().defaultTo('active')
    t.integer('sort').nullable()
    t.datetime('created_at').defaultTo(knex.fn.now())
  })

  await knex.schema.createTable('nivaro_metric_alert_rules', (t) => {
    t.increments('id').primary()
    t.string('name', 255).notNullable()
    t.integer('definition_id')
      .notNullable()
      .references('id')
      .inTable('nivaro_metric_definitions')
      .onDelete('CASCADE')
    t.string('operator', 20).notNullable() // gt|gte|lt|lte|eq|change_pct
    t.decimal('threshold_value', 18, 4).notNullable()
    t.text('filters').nullable() // JSON Record<string, (string|number)[]>
    t.string('check_frequency', 20).notNullable().defaultTo('daily') // hourly|daily|weekly
    t.boolean('is_shared').notNullable().defaultTo(false)
    t.string('status', 20).notNullable().defaultTo('active') // active|paused|archived
    t.uuid('created_by').nullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
    t.datetime('created_at').defaultTo(knex.fn.now())
    t.datetime('updated_at').defaultTo(knex.fn.now())
  })

  await knex.schema.createTable('nivaro_metric_alert_subscriptions', (t) => {
    t.increments('id').primary()
    t.integer('rule_id')
      .notNullable()
      .references('id')
      .inTable('nivaro_metric_alert_rules')
      .onDelete('CASCADE')
    t.uuid('user').notNullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
    t.boolean('delivery_in_app').notNullable().defaultTo(true)
    t.boolean('delivery_email').notNullable().defaultTo(false)
    t.string('digest_frequency', 20).notNullable().defaultTo('immediate') // immediate|daily|weekly
    t.datetime('last_notified').nullable()
    t.string('status', 20).notNullable().defaultTo('active')
    t.datetime('created_at').defaultTo(knex.fn.now())
    t.unique(['rule_id', 'user'])
  })

  await knex.schema.createTable('nivaro_metric_alert_log', (t) => {
    t.increments('id').primary()
    t.integer('rule_id')
      .notNullable()
      .references('id')
      .inTable('nivaro_metric_alert_rules')
      .onDelete('CASCADE')
    t.datetime('fired_at').notNullable()
    t.datetime('resolved_at').nullable()
    t.decimal('metric_value', 18, 4).notNullable()
    t.decimal('threshold_value', 18, 4).notNullable()
    t.text('filters_snapshot').nullable()
    t.string('status', 20).notNullable().defaultTo('firing') // firing|resolved
  })

  await knex.schema.createTable('nivaro_anomaly_definitions', (t) => {
    t.increments('id').primary()
    t.string('key', 50).notNullable() // amount_outlier|period_spike|duplicate_pattern
    t.string('name', 255).notNullable()
    t.text('description').nullable()
    t.string('category', 50).notNullable().defaultTo('general')
    // JSON detector config: {collection, value_field, date_field,
    //   group_by: [{field, label?}], label_field?, scope_fields?: {scopeKey: fieldPath}}
    t.text('config').notNullable()
    t.string('status', 20).notNullable().defaultTo('active')
    t.datetime('created_at').defaultTo(knex.fn.now())
  })

  await knex.schema.createTable('nivaro_anomaly_rules', (t) => {
    t.increments('id').primary()
    t.string('name', 255).notNullable()
    t.integer('definition_id')
      .notNullable()
      .references('id')
      .inTable('nivaro_anomaly_definitions')
      .onDelete('CASCADE')
    t.string('sensitivity', 10).notNullable().defaultTo('medium') // low|medium|high
    t.text('scopes').nullable() // JSON Record<scopeKey, (string|number)[]>
    t.string('check_frequency', 20).notNullable().defaultTo('daily') // daily|weekly
    t.boolean('delivery_in_app').notNullable().defaultTo(true)
    t.boolean('delivery_email').notNullable().defaultTo(false)
    t.string('status', 20).notNullable().defaultTo('active') // active|paused
    t.uuid('created_by').nullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
    t.datetime('created_at').defaultTo(knex.fn.now())
    t.datetime('updated_at').defaultTo(knex.fn.now())
  })

  await knex.schema.createTable('nivaro_anomaly_log', (t) => {
    t.increments('id').primary()
    t.integer('rule_id')
      .notNullable()
      .references('id')
      .inTable('nivaro_anomaly_rules')
      .onDelete('CASCADE')
    t.datetime('detected_at').notNullable()
    t.datetime('resolved_at').nullable()
    t.string('subject_type', 50).notNullable()
    t.string('subject_id', 255).notNullable()
    t.text('stats_snapshot').nullable()
    t.text('ai_explanation').nullable()
    t.string('status', 20).notNullable().defaultTo('new') // new|acknowledged|resolved
    t.datetime('created_at').defaultTo(knex.fn.now())
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_anomaly_log')
  await knex.schema.dropTableIfExists('nivaro_anomaly_rules')
  await knex.schema.dropTableIfExists('nivaro_anomaly_definitions')
  await knex.schema.dropTableIfExists('nivaro_metric_alert_log')
  await knex.schema.dropTableIfExists('nivaro_metric_alert_subscriptions')
  await knex.schema.dropTableIfExists('nivaro_metric_alert_rules')
  await knex.schema.dropTableIfExists('nivaro_metric_definitions')
}
