import type { Knex } from 'knex'

/**
 * Test mode for web push and Teams (#832), the sibling of mail (169) and
 * SMS (170) test mode.
 *   - push_test_mode (bit), push_test_recipient (the email of the person who
 *     receives redirected pushes), push_test_allowlist (comma list of emails
 *     or @domains that still receive their own pushes).
 *   - teams_test_mode (bit), teams_test_webhook_url (the Teams channel that
 *     receives redirected cards; empty = cards are dropped).
 * PUSH_TEST_MODE / TEAMS_TEST_MODE in the environment force the mode on.
 */
const COLS: Array<[string, (t: Knex.AlterTableBuilder) => void]> = [
  ['push_test_mode', (t) => t.boolean('push_test_mode').notNullable().defaultTo(false)],
  ['push_test_recipient', (t) => t.string('push_test_recipient', 500).nullable()],
  ['push_test_allowlist', (t) => t.text('push_test_allowlist').nullable()],
  ['teams_test_mode', (t) => t.boolean('teams_test_mode').notNullable().defaultTo(false)],
  ['teams_test_webhook_url', (t) => t.text('teams_test_webhook_url').nullable()]
]

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_settings'))) return
  for (const [name, add] of COLS) {
    if (!(await knex.schema.hasColumn('nivaro_settings', name)))
      await knex.schema.alterTable('nivaro_settings', (t) => add(t))
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_settings'))) return
  for (const [name] of COLS) {
    if (await knex.schema.hasColumn('nivaro_settings', name))
      await knex.schema.alterTable('nivaro_settings', (t) => t.dropColumn(name))
  }
}
