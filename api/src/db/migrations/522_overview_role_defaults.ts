import type { Knex } from 'knex'

/**
 * Migration 522 — Overview page starter layouts per role.
 *
 *   nivaro_settings.overview_role_defaults  text NULL
 *     JSON `{ <role uuid>: { order: string[], hidden: string[], shown: string[] } }` — the
 *     section order and visibility a role's people start from on the Overview page (route `/`)
 *     until they customise their own (nivaro_users.preferences.overview.layout). Written only by
 *     PUT /api/overview/role-defaults (admin); services/overview/prefs.ts normalizeRoleDefaults is
 *     the one writer shape. Section KEYS are not validated against a list server-side: they name
 *     the admin app's section registry (admin/src/pages/overview/registry.ts).
 *
 * Config, like dashboard_role_defaults (migration 365). Guarded + additive.
 */
const COLUMN = 'overview_role_defaults'

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_settings'))) return
  if (await knex.schema.hasColumn('nivaro_settings', COLUMN)) return
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.text(COLUMN).nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_settings'))) return
  if (!(await knex.schema.hasColumn('nivaro_settings', COLUMN))) return
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.dropColumn(COLUMN)
  })
}
