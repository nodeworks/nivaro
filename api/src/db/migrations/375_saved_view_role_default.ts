import type { Knex } from 'knex'

/**
 * nivaro_saved_views.default_for_role (#672) — an optional role-level default
 * view. For members of that role it wins over the collection-wide
 * `is_default` view; everyone else keeps getting `is_default` exactly as
 * before. One per (collection, role), admin-set. No FK: a deleted role simply
 * never matches.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_saved_views'))) return
  if (await knex.schema.hasColumn('nivaro_saved_views', 'default_for_role')) return
  await knex.schema.alterTable('nivaro_saved_views', (t) => {
    t.uuid('default_for_role').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_saved_views'))) return
  if (await knex.schema.hasColumn('nivaro_saved_views', 'default_for_role')) {
    await knex.schema.alterTable('nivaro_saved_views', (t) => {
      t.dropColumn('default_for_role')
    })
  }
}
