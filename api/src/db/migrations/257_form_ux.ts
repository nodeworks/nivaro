import type { Knex } from 'knex'

/**
 * Record & Form UX sprint: conditional wizard steps (#139) + group-level role
 * visibility (#390) on field groups.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_field_groups', 'visible_when'))) {
    await knex.schema.alterTable('nivaro_field_groups', (t) => {
      t.text('visible_when').nullable() // JSON [{field, op, value}] — AND
      t.text('hidden_for_roles').nullable() // JSON [role uuid, ...]
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_field_groups', (t) => {
    t.dropColumn('visible_when')
    t.dropColumn('hidden_for_roles')
  })
}
