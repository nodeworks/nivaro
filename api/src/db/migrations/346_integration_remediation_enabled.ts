import type { Knex } from 'knex'

/**
 * Integration remediation (Task 19): the switch that lets Nivaro act on an
 * unmet obligation by itself — Send now, the automatic retry ladder for a
 * failure whose cause looks transient, and the one-shot re-fire of a
 * `missing` obligation (the sweep found no send was ever attempted).
 *
 * Deliberately a CORE setting, not an extension setting: `sendNow`,
 * `runRetryPass` and `runMissingRefirePass` live in `api/src/services/`, and
 * core must never read an extension's config to decide whether it may act.
 * Off by default, same posture as `integration_notifications_enabled`
 * (migration 345) — a deployment turns this on only once the ledger looks
 * sane, since every function that SENDS is gated on it and returns without
 * acting while it reads false.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'integration_remediation_enabled'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.boolean('integration_remediation_enabled').notNullable().defaultTo(false)
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'integration_remediation_enabled')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('integration_remediation_enabled')
    })
  }
}
