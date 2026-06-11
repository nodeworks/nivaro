import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  // is_redacted flag on users — add nullable first (MSSQL NOT NULL rule)
  await knex.schema.alterTable('nivaro_users', (t) => {
    t.boolean('is_redacted').nullable()
    t.dateTime('redacted_at').nullable()
  })
  await knex('nivaro_users').update({ is_redacted: false })
  await knex.schema.alterTable('nivaro_users', (t) => {
    t.boolean('is_redacted').notNullable().defaultTo(false).alter()
  })

  // Retention policy definitions
  await knex.schema.createTable('nivaro_retention_policies', (t) => {
    t.increments('id')
    t.string('name', 255).notNullable()
    t.integer('inactivity_threshold_months').notNullable().defaultTo(36)
    t.string('action', 32).notNullable().defaultTo('redact') // redact | delete | suspend_only
    t.text('redact_fields').nullable()        // JSON string[]
    t.string('redact_value_template', 500).nullable().defaultTo('Redacted_{{id}}')
    t.text('exclusion_emails').nullable()     // JSON string[]
    t.text('exclusion_roles').nullable()      // JSON string[] (role IDs)
    t.string('cron_schedule', 100).nullable() // null = manual only
    t.boolean('is_active').notNullable().defaultTo(true)
    t.boolean('dry_run_mode').notNullable().defaultTo(false)
    t.dateTime('last_run_at').nullable()
    t.integer('last_run_affected_count').nullable()
    t.uuid('created_by').nullable().references('id').inTable('nivaro_users').onDelete('SET NULL')
    t.timestamps(true, true)
  })

  // Run history log
  await knex.schema.createTable('nivaro_retention_runs', (t) => {
    t.increments('id')
    t.integer('policy_id').notNullable().references('id').inTable('nivaro_retention_policies').onDelete('CASCADE')
    t.dateTime('started_at').notNullable()
    t.dateTime('finished_at').nullable()
    t.integer('affected_count').notNullable().defaultTo(0)
    t.boolean('dry_run').notNullable().defaultTo(false)
    t.text('errors').nullable() // JSON string[]
    t.text('affected_ids').nullable() // JSON string[] - sampled user IDs for audit
    t.uuid('triggered_by').nullable().references('id').inTable('nivaro_users').onDelete('SET NULL')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_retention_runs')
  await knex.schema.dropTableIfExists('nivaro_retention_policies')
  await knex.schema.alterTable('nivaro_users', (t) => {
    t.dropColumn('is_redacted')
    t.dropColumn('redacted_at')
  })
}
