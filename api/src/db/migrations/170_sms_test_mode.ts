import type { Knex } from 'knex'

// SMS test mode — SMS counterpart of mail test mode (migration 169): when
// enabled, every outgoing SMS is redirected to sms_test_recipient (body
// prefixed with the original number) so dev/staging never texts real users.
// sms_test_allowlist is a comma list of phone numbers that still receive
// normally. SMS_TEST_MODE / SMS_TEST_RECIPIENT env vars override the settings.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.boolean('sms_test_mode').notNullable().defaultTo(false)
    t.string('sms_test_recipient', 50).nullable()
    t.text('sms_test_allowlist').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.dropColumn('sms_test_mode')
    t.dropColumn('sms_test_recipient')
    t.dropColumn('sms_test_allowlist')
  })
}
