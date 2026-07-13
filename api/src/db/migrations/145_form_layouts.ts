import type { Knex } from 'knex'

/**
 * Layout-backed public forms: a submission form may reference a grouped
 * collection layout — the public renderer then uses the layout's groups
 * (sections or step wizard via tab_mode), field order, labels, and
 * visibility rules instead of the flat fields list. No FK: a deleted layout
 * degrades gracefully to the flat list.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_submission_forms', (t) => {
    t.integer('layout_id')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_submission_forms', (t) => {
    t.dropColumn('layout_id')
  })
}
