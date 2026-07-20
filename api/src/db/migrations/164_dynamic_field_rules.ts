import type { Knex } from 'knex'

// Dynamic field rules: cascading auto-fill target types (`set_lookup`,
// `set_from_trigger`) plus an only-when-empty guard on nivaro_field_rules.
// `dynamic_config` holds type-specific JSON (see api/src/services/field-rules.ts).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_field_rules', (t) => {
    t.boolean('only_when_empty').notNullable().defaultTo(false)
    t.text('dynamic_config').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_field_rules', (t) => {
    t.dropColumn('only_when_empty')
    t.dropColumn('dynamic_config')
  })
}
