import type { Knex } from 'knex'

/**
 * Per-role home-page defaults (#917): `nivaro_settings.dashboard_role_defaults`
 * holds `{ <role uuid>: layout }` — the arrangement a person starts from until
 * they customise their own (`preferences.dashboard`, #848). JSON text, admin
 * PATCH-allowlisted, readable through the ordinary settings GET. Additive,
 * nullable; NULL = every role starts from the app's code-seeded layout.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'dashboard_role_defaults'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('dashboard_role_defaults').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'dashboard_role_defaults')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('dashboard_role_defaults')
    })
  }
}
