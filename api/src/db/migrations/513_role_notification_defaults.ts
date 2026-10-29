import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Migration 513 — default notification rules by role (#3077).
 *
 *   nivaro_role_notification_defaults
 *     id          int identity PK
 *     role_id     uuid NOT NULL UNIQUE, FK → nivaro_roles.id (NO ACTION — the role delete
 *                 route removes the row first)
 *     rules       nvarchar(max) NOT NULL — JSON in the SAME shape as a person's own
 *                 preferences.notification_prefs ({quiet_start, quiet_end, matrix, escalation});
 *                 services/notification-layers.ts sanitizeNotifyRules() is the one writer shape
 *     updated_at  datetime NOT NULL default UTC now
 *     updated_by  uuid NULL (no FK: a removed admin never blocks the row)
 *
 * Never copied onto people: decideDelivery() merges the person's own rules over their CURRENT
 * role's defaults at decide time, so a role change brings the new role's defaults for anything
 * the person never set. CONFIG table (promote with roles). Guarded + additive.
 */
const TABLE = 'nivaro_role_notification_defaults'

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) return
  if (!(await knex.schema.hasTable('nivaro_roles'))) return
  await knex.schema.createTable(TABLE, (t) => {
    t.increments('id').primary()
    t.uuid('role_id').notNullable().unique().references('id').inTable('nivaro_roles')
    t.text('rules').notNullable()
    t.datetime('updated_at').notNullable().defaultTo(utcNow(knex))
    t.uuid('updated_by').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) await knex.schema.dropTable(TABLE)
}
