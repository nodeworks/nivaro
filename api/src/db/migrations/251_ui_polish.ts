import type { Knex } from 'knex'

/**
 * UI polish sprint (#347): configurable help/support links on the login
 * screen. JSON array [{label, url}] on the settings singleton.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'login_links'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('login_links').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.dropColumn('login_links')
  })
}
