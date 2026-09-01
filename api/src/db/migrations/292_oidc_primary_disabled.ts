import type { Knex } from 'knex'

/**
 * UI-togglable disable for the env-configured default OIDC provider. The
 * provider itself stays env config (OIDC_ISSUER etc.); this bit just parks
 * it off the login page. Honored only while at least one ACTIVE custom
 * provider (nivaro_sso_providers) exists — the no-lockout rule.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'oidc_primary_disabled'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.boolean('oidc_primary_disabled').defaultTo(false)
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'oidc_primary_disabled')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('oidc_primary_disabled')
    })
  }
}
