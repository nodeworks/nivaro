import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_layout_field_assignments', 'hide_actions_when_collapsed')
  if (!has) {
    await knex.raw(
      `ALTER TABLE nivaro_layout_field_assignments ADD hide_actions_when_collapsed bit NOT NULL DEFAULT 0`
    )
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_layout_field_assignments', 'hide_actions_when_collapsed')
  if (has) {
    await knex.schema.alterTable('nivaro_layout_field_assignments', (t) => {
      t.dropColumn('hide_actions_when_collapsed')
    })
  }
}
