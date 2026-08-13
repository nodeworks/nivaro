import type { Knex } from 'knex'

/**
 * What the online/presence lists show under each person's name.
 *
 * JSON: {"fields":["role","scopes","page"],"scope_dimensions":["division","region"]}
 * null = the historic default (role + current page). Kept as instance config
 * rather than per-host code so admin, efp-new and any other host agree.
 */
export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_settings', 'presence_display')
  if (!has) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('presence_display').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_settings', 'presence_display')
  if (has) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('presence_display')
    })
  }
}
