import type { Knex } from 'knex'

/**
 * Scoped teams — a team optionally declares scope-dimension values (Zone 1 +
 * BLT…), mirroring nivaro_user_scopes at team level. Dimensions AND together,
 * values within one dimension OR; a dimension with no row = unrestricted.
 * Purely advisory: pickers rank matching teams/people first, overrides always
 * allowed — never enforcement.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_team_scopes'))) {
    await knex.schema.createTable('nivaro_team_scopes', (t) => {
      t.increments('id')
      t.integer('team_id')
        .notNullable()
        .references('id')
        .inTable('nivaro_user_groups')
        .onDelete('CASCADE')
      /** nivaro_scope_dimensions.name slug ('division', 'region', …). */
      t.string('dimension', 100).notNullable()
      /** JSON array of TARGET collection ids (rename-proof, like user scopes). */
      t.text('values').notNullable()
      t.unique(['team_id', 'dimension'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_team_scopes')
}
