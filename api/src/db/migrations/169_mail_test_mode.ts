import type { Knex } from 'knex'

// Mail test mode: when enabled, ALL outgoing mail is redirected to
// mail_test_recipient (subject tagged with the original recipients) so
// dev/staging environments never email real users. mail_test_allowlist is a
// comma list of exact addresses and/or @domains that still receive normally.
// The MAIL_TEST_MODE / MAIL_TEST_RECIPIENT env vars override these settings —
// a staging box stays protected even after a prod-DB restore flips the bit off.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.boolean('mail_test_mode').notNullable().defaultTo(false)
    t.string('mail_test_recipient', 500).nullable()
    t.text('mail_test_allowlist').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.dropColumn('mail_test_mode')
    t.dropColumn('mail_test_recipient')
    t.dropColumn('mail_test_allowlist')
  })
}
