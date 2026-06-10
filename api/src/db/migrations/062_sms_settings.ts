import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.string('sms_provider', 50).nullable() // twilio | aws-sns | vonage | sinch | messagebird
    t.string('sms_account_sid', 255).nullable() // Twilio Account SID / AWS Access Key / Vonage API Key / etc.
    t.string('sms_auth_token', 500).nullable() // masked on GET
    t.string('sms_from', 100).nullable() // sender number or name
    t.string('sms_region', 50).nullable() // AWS SNS region
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.dropColumn('sms_provider')
    t.dropColumn('sms_account_sid')
    t.dropColumn('sms_auth_token')
    t.dropColumn('sms_from')
    t.dropColumn('sms_region')
  })
}
