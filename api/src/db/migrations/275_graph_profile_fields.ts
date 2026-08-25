import type { Knex } from 'knex'

/**
 * Extra Microsoft Graph profile fields captured at OIDC login (all free under
 * the existing User.Read scope): office location + city/state/country for the
 * people map, employeeId for HR-import matching, preferredLanguage for future
 * locale defaults. IdP wins on every login, same as title/department/company.
 */
export async function up(knex: Knex): Promise<void> {
  const cols: Array<[string, number]> = [
    ['office_location', 255],
    ['city', 255],
    ['state', 255],
    ['country', 255],
    ['employee_id', 100],
    ['preferred_language', 20]
  ]
  for (const [col, len] of cols) {
    const has = await knex.schema.hasColumn('nivaro_users', col)
    if (!has) {
      await knex.schema.alterTable('nivaro_users', (t) => {
        t.string(col, len).nullable()
      })
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const col of [
    'office_location',
    'city',
    'state',
    'country',
    'employee_id',
    'preferred_language'
  ]) {
    const has = await knex.schema.hasColumn('nivaro_users', col)
    if (has) {
      await knex.schema.alterTable('nivaro_users', (t) => {
        t.dropColumn(col)
      })
    }
  }
}
