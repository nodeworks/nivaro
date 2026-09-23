import type { Knex } from 'knex'

/**
 * Integration notifications (Task 18): the moment
 * `nivaro_integration_obligations` starts carrying real history, the
 * reconcile sweep can already find a backlog of `failed` / `missing` /
 * `overdue` rows — notifying on all of them at once on a first deploy would
 * flood record owners and API owners with a wall of mail nobody asked for.
 * Off by default; an admin turns it on from Settings → Integrations once the
 * ledger looks sane. Task 19's `obligations_remediation` setting is a
 * separate gate — this one only covers whether the sweep may TELL a person,
 * never whether anything is sent to a partner.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'integration_notifications_enabled'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.boolean('integration_notifications_enabled').notNullable().defaultTo(false)
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'integration_notifications_enabled')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('integration_notifications_enabled')
    })
  }
}
