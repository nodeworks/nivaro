import type { Knex } from 'knex'

/**
 * Inbound attribution (#609 / #617): which credential a write arrived on.
 *
 * nivaro_activity already names the USER behind a write, but a named API key
 * acts as its OWNER — often an administrator — so a partner's writes through a
 * key read as that person's edits, and a static-token integration is only
 * recognisable by guessing from the account. Two nullable columns say it
 * plainly:
 *
 *   api_key_id  — nivaro_api_keys.id when the request authenticated with a
 *                 named key (no FK: a revoked/deleted key must never block an
 *                 audit write, and history must survive the key's removal)
 *   auth_method — how the request authenticated: session | token | api_key |
 *                 masquerade | key_sim (NULL = no request, i.e. a cron or
 *                 background job, or a row written before this migration)
 *
 * Adding nullable columns is metadata-only on SQL Server, so this is instant
 * on the 11M-row activity table. No index: per-caller reads narrow by the
 * existing (user, timestamp) index first — a key's writes are its owner's.
 *
 * Writers probe the columns (lib/column-probe.ts), so an image ahead of this
 * migration keeps writing.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_activity'))) return
  const hasKey = await knex.schema.hasColumn('nivaro_activity', 'api_key_id')
  const hasAuth = await knex.schema.hasColumn('nivaro_activity', 'auth_method')
  if (hasKey && hasAuth) return
  await knex.schema.alterTable('nivaro_activity', (t) => {
    if (!hasKey) t.integer('api_key_id').nullable()
    if (!hasAuth) t.string('auth_method', 20).nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_activity'))) return
  const hasKey = await knex.schema.hasColumn('nivaro_activity', 'api_key_id')
  const hasAuth = await knex.schema.hasColumn('nivaro_activity', 'auth_method')
  if (!hasKey && !hasAuth) return
  await knex.schema.alterTable('nivaro_activity', (t) => {
    if (hasKey) t.dropColumn('api_key_id')
    if (hasAuth) t.dropColumn('auth_method')
  })
}
