import type { Knex } from 'knex'

/**
 * Provisional-account roles for self-service sign-ups.
 *
 *   nivaro_settings.new_user_role        role uuid given to an account created
 *                                        by a first OIDC/SAML sign-in (after any
 *                                        AD-group mapping; NULL = the first
 *                                        non-admin app role, the old behaviour)
 *   nivaro_settings.access_request_role  role uuid the account moves to when the
 *                                        person submits an access request from
 *                                        the awaiting-authorization page
 *                                        (POST /users/me/access-request);
 *                                        NULL = the role is left alone
 */
export async function up(knex: Knex): Promise<void> {
  const add = async (col: string, fn: (t: Knex.CreateTableBuilder) => void) => {
    if (!(await knex.schema.hasColumn('nivaro_settings', col))) {
      await knex.schema.alterTable('nivaro_settings', fn)
    }
  }
  await add('new_user_role', (t) => {
    t.uuid('new_user_role').nullable()
  })
  await add('access_request_role', (t) => {
    t.uuid('access_request_role').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  for (const col of ['new_user_role', 'access_request_role']) {
    if (await knex.schema.hasColumn('nivaro_settings', col)) {
      await knex.schema.alterTable('nivaro_settings', (t) => {
        t.dropColumn(col)
      })
    }
  }
}
