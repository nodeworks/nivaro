import type { Knex } from 'knex'

/**
 * nivaro_settings.session_policy (#665) — how long a signed-in browser
 * session may live and how long it may sit idle, as JSON:
 *   { max_age_hours?: n|null, idle_minutes?: n|null,
 *     roles?: { <role uuid>: { max_age_hours?, idle_minutes? } } }
 * NULL = no policy (the SESSION_TTL env, rolled on every request, is the only
 * bound — the historic behaviour). Read by services/session-policy.ts, judged
 * in the session branch of middleware/authenticate.ts.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_settings'))) return
  if (await knex.schema.hasColumn('nivaro_settings', 'session_policy')) return
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.text('session_policy').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_settings'))) return
  if (await knex.schema.hasColumn('nivaro_settings', 'session_policy')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('session_policy')
    })
  }
}
