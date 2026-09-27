import type { Knex } from 'knex'

/**
 * API batch (2026-09-27):
 *  - nivaro_webhooks.conditions — text JSON `[{field, op, value}]`, AND. A
 *    webhook carrying conditions fires only for records that match them.
 *    NULL / empty = every record of its collections, as before.
 *  - nivaro_settings.transition_guard_seconds — int nullable. How long the
 *    same manual transition on the same record is refused after it was made
 *    (a double-click, a retried request). NULL = the default of 10 seconds,
 *    0 = the guard is off.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_webhooks', 'conditions'))) {
    await knex.schema.alterTable('nivaro_webhooks', (t) => {
      t.text('conditions').nullable()
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_settings', 'transition_guard_seconds'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.integer('transition_guard_seconds').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_webhooks', 'conditions')) {
    await knex.schema.alterTable('nivaro_webhooks', (t) => t.dropColumn('conditions'))
  }
  if (await knex.schema.hasColumn('nivaro_settings', 'transition_guard_seconds')) {
    await knex.schema.alterTable('nivaro_settings', (t) => t.dropColumn('transition_guard_seconds'))
  }
}
