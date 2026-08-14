import type { Knex } from 'knex'

/**
 * Fingerprint of the record values a push was made FOR.
 *
 * Lets a transition action say "only push when these fields actually changed":
 * without somewhere to record what was last sent, every transition looks like
 * a change and the external system is told the same thing repeatedly. Compared
 * against the newest successful submission for the same record + endpoint.
 *
 * NULL on every historical row, which reads as "unknown" — the first push after
 * this ships always goes out rather than being suppressed by a comparison that
 * has nothing to compare against.
 */
export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_erp_submissions', 'change_signature')
  if (!has) {
    await knex.schema.alterTable('nivaro_erp_submissions', (t) => {
      t.string('change_signature', 64).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_erp_submissions', 'change_signature')
  if (has) {
    await knex.schema.alterTable('nivaro_erp_submissions', (t) => {
      t.dropColumn('change_signature')
    })
  }
}
