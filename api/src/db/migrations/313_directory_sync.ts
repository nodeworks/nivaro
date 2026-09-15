import type { Knex } from 'knex'

/**
 * Directory sync (2026-09-15) — "is this person still with the company?"
 *  - nivaro_users.directory_status — varchar(20) nullable: 'active' (found in
 *    the tenant directory, account enabled), 'disabled' (found, account
 *    disabled) or 'missing' (no directory entry). NULL = never checked.
 *  - nivaro_users.directory_checked_at — when the verdict was last taken.
 *  - nivaro_users.directory_id — the Graph object id once matched, so a
 *    renamed mailbox still maps to the same person.
 *  - nivaro_settings.directory_sync_enabled — bit, default 0: the nightly
 *    directory-sync cron only runs when this is on (and the app token
 *    actually carries the directory permission).
 *  - nivaro_settings.directory_sync_suspend — bit, default 1: a person the
 *    directory no longer has (missing or disabled) is suspended. Redaction is
 *    a separate, deliberate admin action and is never touched here.
 *  - nivaro_settings.directory_sync_last_run / _last_summary — the newest
 *    run's timestamp and JSON summary for the Settings card.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_users', 'directory_status'))) {
    await knex.schema.alterTable('nivaro_users', (t) => {
      t.string('directory_status', 20).nullable()
      t.datetime('directory_checked_at').nullable()
      t.string('directory_id', 64).nullable()
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_settings', 'directory_sync_enabled'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.boolean('directory_sync_enabled').notNullable().defaultTo(false)
      t.boolean('directory_sync_suspend').notNullable().defaultTo(true)
      t.datetime('directory_sync_last_run').nullable()
      t.text('directory_sync_last_summary').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_users', 'directory_status')) {
    await knex.schema.alterTable('nivaro_users', (t) => {
      t.dropColumn('directory_status')
      t.dropColumn('directory_checked_at')
      t.dropColumn('directory_id')
    })
  }
  if (await knex.schema.hasColumn('nivaro_settings', 'directory_sync_enabled')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('directory_sync_enabled')
      t.dropColumn('directory_sync_suspend')
      t.dropColumn('directory_sync_last_run')
      t.dropColumn('directory_sync_last_summary')
    })
  }
}
