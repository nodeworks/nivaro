import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  const hasLabel = await knex.schema.hasColumn('nivaro_layout_field_assignments', 'label_override')
  if (!hasLabel) {
    await knex.schema.alterTable('nivaro_layout_field_assignments', (t) => {
      t.string('label_override', 255).nullable()
    })
  }

  const hasVisible = await knex.schema.hasColumn('nivaro_layout_field_assignments', 'is_visible')
  if (!hasVisible) {
    await knex.schema.alterTable('nivaro_layout_field_assignments', (t) => {
      t.specificType('is_visible', 'bit').notNullable().defaultTo(1)
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_layout_field_assignments', (t) => {
    t.dropColumn('label_override')
    t.dropColumn('is_visible')
  })
}
