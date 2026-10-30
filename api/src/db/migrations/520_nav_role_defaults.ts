import type { Knex } from 'knex'

/**
 * Per-role sidebar starter layouts (#3227): `nivaro_settings.nav_role_defaults`
 * holds `{ <ROLE UUID>: { v: 1, categories: { <nav category id>: { order, hidden,
 * pinned } } } }` — the sidebar arrangement a person gets until they customise
 * their own (`preferences.nav_layout`). JSON text, written only by
 * routes/nav-layout.ts. Additive and nullable; NULL = every role starts from the
 * code nav map.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'nav_role_defaults'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('nav_role_defaults').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'nav_role_defaults')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('nav_role_defaults')
    })
  }
}
