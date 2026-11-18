import type { Knex } from 'knex'

/**
 * Resends on the mail log (Rob 2026-11-18): "when I resend an email the log
 * should show it has been resent and how that went".
 *
 *   nivaro_mail_log.resend_of  int, nullable, indexed — the ORIGINAL row a
 *                              resend replays (a resend of a resend points at
 *                              the same original, so the chain stays flat)
 *   nivaro_mail_log.resent_by  uuid, nullable — the administrator who pressed
 *                              Resend (no FK: the log outlives accounts and is
 *                              pruned on its own schedule)
 *
 * Every reader and the logger probe the columns (services/mail-resends.ts),
 * so a tenant behind this migration keeps logging and listing. Additive,
 * guarded both ways.
 */
const TABLE = 'nivaro_mail_log'
const INDEX = 'nivaro_mail_log_resend_of_index'

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (!(await knex.schema.hasColumn(TABLE, 'resend_of'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.integer('resend_of').nullable()
      t.index(['resend_of'], INDEX)
    })
  }
  if (!(await knex.schema.hasColumn(TABLE, 'resent_by'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.uuid('resent_by').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (await knex.schema.hasColumn(TABLE, 'resend_of')) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.dropIndex(['resend_of'], INDEX)
      t.dropColumn('resend_of')
    })
  }
  if (await knex.schema.hasColumn(TABLE, 'resent_by')) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.dropColumn('resent_by')
    })
  }
}
