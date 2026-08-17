import type { Knex } from 'knex'

/**
 * Row-level scoping for API keys.
 *
 * A key already resolves to its OWNER's identity, so a key minted by a scoped
 * user was always row-scoped — but integration keys are minted by admins,
 * and an admin-owned key saw everything. `scope_restrictions` narrows a key
 * to specific User Scope dimension values regardless of who owns it:
 *
 *   [{ "dimension": "division", "values": [1] }]
 *
 * Enforcement rides the existing user-scope machinery (getUserScopeEnforcement
 * merges these as extra restrict rows), and — deliberately — it applies even
 * when the key's owner is an admin: restricting a key is the point of setting
 * this, and "admin bypasses everything" would make the field a no-op on
 * exactly the keys it exists for.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_api_keys', 'scope_restrictions')) return
  await knex.schema.alterTable('nivaro_api_keys', (t) => {
    t.text('scope_restrictions').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_api_keys', 'scope_restrictions'))) return
  await knex.schema.alterTable('nivaro_api_keys', (t) => t.dropColumn('scope_restrictions'))
}
