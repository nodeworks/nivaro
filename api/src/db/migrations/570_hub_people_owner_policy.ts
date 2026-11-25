import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub enhancements (people directory + offboarding, app owner self-service). Created on
 * every install, used only in hub mode. No foreign keys; each step is skipped when it exists.
 *
 *  - nivaro_hub_apps.owners_deploy_production  an admin's per-app switch: the app's owners may
 *                                              also promote, restart and apply on production
 *                                              (NULL / false = production stays admin-only)
 *  - nivaro_hub_offboards                      one row per "Offboard everywhere": who (the
 *                                              identities asked about), per-environment results,
 *                                              and the Hub sign-in block (`blocked`) that holds
 *                                              until an administrator lifts it
 */
export async function up(knex: Knex): Promise<void> {
  if (
    (await knex.schema.hasTable('nivaro_hub_apps')) &&
    !(await knex.schema.hasColumn('nivaro_hub_apps', 'owners_deploy_production'))
  ) {
    await knex.schema.alterTable('nivaro_hub_apps', (t) => {
      t.boolean('owners_deploy_production').nullable().defaultTo(false)
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_offboards'))) {
    await knex.schema.createTable('nivaro_hub_offboards', (t) => {
      t.increments('id').primary()
      // What the page shows (a name and/or the email); never used to match anyone.
      t.string('label', 400).nullable()
      // The directory key the run was started from (u:<hub user id> | k:<sign-in row id>).
      t.string('person_key', 80).nullable()
      t.uuid('hub_user_id').nullable()
      // JSON {emails: string[], entra: [{tid, oid}]}: what every app was asked about.
      longText(t, knex, 'identity').notNullable()
      t.string('status', 16).notNullable().defaultTo('running')
      // JSON array, one entry per environment (services/hub/people/offboard.ts OffboardResult).
      longText(t, knex, 'results').nullable()
      // The Hub's own account: suspended | none | kept (refused: the caller / the last admin).
      t.string('hub_account', 16).nullable()
      t.boolean('blocked').nullable().defaultTo(true)
      t.uuid('started_by').nullable()
      t.dateTime('started_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('heartbeat_at').nullable()
      t.dateTime('finished_at').nullable()
      t.uuid('lifted_by').nullable()
      t.dateTime('lifted_at').nullable()
      t.index(['hub_user_id'], 'ix_nivaro_hub_offboard_user')
      t.index(['person_key'], 'ix_nivaro_hub_offboard_person')
      t.index(['blocked'], 'ix_nivaro_hub_offboard_blocked')
    })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: tables may hold live hub data.
}
