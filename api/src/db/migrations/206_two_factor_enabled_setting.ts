import type { Knex } from 'knex'

/**
 * Whether two-factor is offered at all.
 *
 * The profile page always showed a "set up two-factor" flow, whether or not the
 * deployment uses it — inviting people to configure something nobody supports,
 * then leaving them holding an authenticator entry for an instance that never
 * asks for a code.
 *
 * Defaults to TRUE: existing instances may have people already enrolled, and
 * hiding the panel from them would strand the setup they already completed.
 * Turning it off is the deliberate act.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'two_factor_enabled')) return
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.boolean('two_factor_enabled').notNullable().defaultTo(true)
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'two_factor_enabled'))) return
  await knex.schema.alterTable('nivaro_settings', (t) => t.dropColumn('two_factor_enabled'))
}
