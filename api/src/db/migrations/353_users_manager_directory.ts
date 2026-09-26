import type { Knex } from 'knex'

/**
 * Who someone reports to when that manager has no Nivaro account (2026-09-26):
 *  - nivaro_users.manager_directory — nvarchar(max) JSON `{name, email, upn}`,
 *    nullable. Written by the nightly directory sync from Microsoft Graph's
 *    manager relation whenever the manager's mail / UPN matches no account
 *    here; cleared the moment `manager_id` can be set instead. Lets the people
 *    page read "Reports to Sarim Ayyapillai · not a Nivaro user" (with an
 *    email link) instead of nothing, without minting placeholder accounts
 *    that would leak into every people picker. Of 999 active people on the
 *    shared DB, 292 had a Graph manager who never signed in.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_users', 'manager_directory'))) {
    await knex.schema.alterTable('nivaro_users', (t) => {
      t.text('manager_directory').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_users', 'manager_directory')) {
    await knex.schema.alterTable('nivaro_users', (t) => {
      t.dropColumn('manager_directory')
    })
  }
}
