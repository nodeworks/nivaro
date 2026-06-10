import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  // Add new columns to nivaro_fields one at a time (MSSQL ALTER TABLE reliability)
  await knex.schema.alterTable('nivaro_fields', (t) => {
    t.string('group_key', 100).nullable()
  })
  await knex.schema.alterTable('nivaro_fields', (t) => {
    t.specificType('visibility_rules', 'nvarchar(max)').nullable()
  })
  await knex.schema.alterTable('nivaro_fields', (t) => {
    t.specificType('dependency_config', 'nvarchar(max)').nullable()
  })
  await knex.schema.alterTable('nivaro_fields', (t) => {
    t.specificType('validation_rules', 'nvarchar(max)').nullable()
  })
  await knex.schema.alterTable('nivaro_fields', (t) => {
    t.specificType('lock_condition', 'nvarchar(max)').nullable()
  })
  await knex.schema.alterTable('nivaro_fields', (t) => {
    t.string('default_formula', 500).nullable()
  })
  await knex.schema.alterTable('nivaro_fields', (t) => {
    t.specificType('cross_record_defaults', 'nvarchar(max)').nullable()
  })
  await knex.schema.alterTable('nivaro_fields', (t) => {
    t.specificType('remote_options_config', 'nvarchar(max)').nullable()
  })
  await knex.schema.alterTable('nivaro_fields', (t) => {
    t.specificType('repeater_schema', 'nvarchar(max)').nullable()
  })
  await knex.schema.alterTable('nivaro_fields', (t) => {
    t.boolean('is_translatable').notNullable().defaultTo(false)
  })

  // Add new columns to nivaro_collections
  await knex.schema.alterTable('nivaro_collections', (t) => {
    t.boolean('draft_publish_enabled').notNullable().defaultTo(false)
  })
  await knex.schema.alterTable('nivaro_collections', (t) => {
    t.boolean('is_virtual').notNullable().defaultTo(false)
  })
  await knex.schema.alterTable('nivaro_collections', (t) => {
    t.specificType('virtual_sql', 'nvarchar(max)').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_collections', (t) => {
    t.dropColumn('virtual_sql')
    t.dropColumn('is_virtual')
    t.dropColumn('draft_publish_enabled')
  })
  await knex.schema.alterTable('nivaro_fields', (t) => {
    t.dropColumn('is_translatable')
    t.dropColumn('repeater_schema')
    t.dropColumn('remote_options_config')
    t.dropColumn('cross_record_defaults')
    t.dropColumn('default_formula')
    t.dropColumn('lock_condition')
    t.dropColumn('validation_rules')
    t.dropColumn('dependency_config')
    t.dropColumn('visibility_rules')
    t.dropColumn('group_key')
  })
}
