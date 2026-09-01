import type { Knex } from 'knex'

/**
 * Sign-in provider branding: custom OIDC providers (nivaro_sso_providers)
 * get a logo/icon (URL or data URI) and a button color, rendered on the
 * login pages via the public /auth/providers list.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_sso_providers', 'logo_url'))) {
    await knex.schema.alterTable('nivaro_sso_providers', (t) => {
      t.text('logo_url').nullable()
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_sso_providers', 'button_color'))) {
    await knex.schema.alterTable('nivaro_sso_providers', (t) => {
      t.string('button_color', 30).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_sso_providers', 'logo_url')) {
    await knex.schema.alterTable('nivaro_sso_providers', (t) => {
      t.dropColumn('logo_url')
    })
  }
  if (await knex.schema.hasColumn('nivaro_sso_providers', 'button_color')) {
    await knex.schema.alterTable('nivaro_sso_providers', (t) => {
      t.dropColumn('button_color')
    })
  }
}
