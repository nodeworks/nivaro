import type { Knex } from 'knex'

/**
 * Directory lookups can run as a CONNECTED account: an admin signs in as the
 * service account once in the browser (MFA passes there), and Nivaro keeps the
 * refresh token to mint Graph tokens from then on.
 *
 *   nivaro_settings.directory_refresh_token   the stored refresh token (masked
 *                                             on GET like every other secret)
 *   nivaro_settings.directory_connected_user  the UPN that signed in
 *   nivaro_settings.directory_connected_at    when
 *
 * directory_auth_mode gains the value 'connected'.
 */
export async function up(knex: Knex): Promise<void> {
  const add = async (col: string, fn: (t: Knex.CreateTableBuilder) => void) => {
    if (!(await knex.schema.hasColumn('nivaro_settings', col))) {
      await knex.schema.alterTable('nivaro_settings', fn)
    }
  }
  await add('directory_refresh_token', (t) => {
    t.text('directory_refresh_token').nullable()
  })
  await add('directory_connected_user', (t) => {
    t.string('directory_connected_user', 500).nullable()
  })
  await add('directory_connected_at', (t) => {
    t.dateTime('directory_connected_at').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  for (const col of [
    'directory_connected_at',
    'directory_connected_user',
    'directory_refresh_token'
  ]) {
    if (await knex.schema.hasColumn('nivaro_settings', col)) {
      await knex.schema.alterTable('nivaro_settings', (t) => t.dropColumn(col))
    }
  }
}
