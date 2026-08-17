import type { Knex } from 'knex'

/**
 * User avatars — Microsoft Graph profile photo captured at OIDC login, stored
 * as a small data URI (96x96 JPEG, a few KB).
 *
 * The base schema carried an `avatar uniqueidentifier` (legacy Directus file
 * FK) that nothing ever wrote — zero non-null rows on every deployment — so
 * it is converted in place to the data-URI text column. Deliberately NOT part
 * of USER_COLS: an nvarchar(max) blob on every /users listing would bloat the
 * directory responses; it is served by GET /users/:id/avatar only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_users', (t) => {
    t.dropColumn('avatar')
  })
  await knex.schema.alterTable('nivaro_users', (t) => {
    t.text('avatar').nullable()
    t.dateTime('avatar_updated_at').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_users', (t) => {
    t.dropColumn('avatar')
    t.dropColumn('avatar_updated_at')
  })
  await knex.schema.alterTable('nivaro_users', (t) => {
    t.uuid('avatar').nullable()
  })
}
