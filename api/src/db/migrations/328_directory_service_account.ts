import type { Knex } from 'knex'

/**
 * Directory lookups can sign in as a SERVICE ACCOUNT instead of the app.
 *
 *   nivaro_settings.directory_auth_mode  'app' (client credentials — the app
 *                                        registration's APPLICATION permission)
 *                                        or 'service_account' (a named user with
 *                                        a password, delegated permission; the
 *                                        token's `scp` claim carries the grant).
 *   nivaro_settings.directory_username   the service account's sign-in name
 *   nivaro_settings.directory_password   its password — masked on GET like every
 *                                        other secret in the row
 */
export async function up(knex: Knex): Promise<void> {
  const add = async (col: string, fn: (t: Knex.CreateTableBuilder) => void) => {
    if (!(await knex.schema.hasColumn('nivaro_settings', col))) {
      await knex.schema.alterTable('nivaro_settings', fn)
    }
  }
  await add('directory_auth_mode', (t) => {
    t.string('directory_auth_mode', 20).nullable()
  })
  await add('directory_username', (t) => {
    t.string('directory_username', 500).nullable()
  })
  await add('directory_password', (t) => {
    t.string('directory_password', 1000).nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  for (const col of ['directory_password', 'directory_username', 'directory_auth_mode']) {
    if (await knex.schema.hasColumn('nivaro_settings', col)) {
      await knex.schema.alterTable('nivaro_settings', (t) => t.dropColumn(col))
    }
  }
}
