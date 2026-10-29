import type { Knex } from 'knex'
import { isMssql, utcNow } from '../dialect.js'

/**
 * Saved audit views (#11 audit trail findable): a named filter set over nivaro_activity,
 * personal or shared with every administrator, optionally emailed on a schedule.
 *
 *   id              int identity
 *   name            nvarchar(120)  NOT NULL
 *   owner           uuid NULL → nivaro_users.id (NO ACTION). NULL = a system view (the seed),
 *                   editable by any administrator
 *   filters         nvarchar(max)  NOT NULL — JSON ActivityFilters (services/activity-filters.ts)
 *   shared          bit            NOT NULL default 0 — every administrator sees it
 *   schedule        nvarchar(100)  NULL — 5-part cron; NULL = never emailed
 *   recipients      nvarchar(max)  NULL — JSON array of user ids
 *   last_sent_at    datetime2      NULL
 *   last_send_status nvarchar(300) NULL
 *   created_at / updated_at datetime2 NOT NULL default UTC now
 *
 * Seeds one shared view, "Permission changes this week", guarded by name.
 */
const TABLE = 'nivaro_activity_views'
export const PERMISSION_VIEW_NAME = 'Permission changes this week'

export async function up(knex: Knex): Promise<void> {
  const mssql = isMssql(knex)
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.schema.createTable(TABLE, (t) => {
      t.increments('id').primary()
      t.string('name', 120).notNullable()
      t.uuid('owner').nullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
      if (mssql) t.specificType('filters', 'nvarchar(max)').notNullable()
      else t.text('filters', 'longtext').notNullable()
      t.boolean('shared').notNullable().defaultTo(false)
      t.string('schedule', 100).nullable()
      if (mssql) t.specificType('recipients', 'nvarchar(max)').nullable()
      else t.text('recipients', 'longtext').nullable()
      ;(mssql
        ? t.specificType('last_sent_at', 'datetime2')
        : t.timestamp('last_sent_at')
      ).nullable()
      t.string('last_send_status', 300).nullable()
      for (const name of ['created_at', 'updated_at']) {
        ;(mssql ? t.specificType(name, 'datetime2') : t.timestamp(name))
          .notNullable()
          .defaultTo(utcNow(knex))
      }
      t.index(['owner'], 'ix_activity_views_owner')
    })
  }

  const seeded = await knex(TABLE).where({ name: PERMISSION_VIEW_NAME }).first('id')
  if (!seeded) {
    await knex(TABLE).insert({
      name: PERMISSION_VIEW_NAME,
      owner: null,
      shared: true,
      filters: JSON.stringify({
        collections: [
          'nivaro_roles',
          'nivaro_policies',
          'nivaro_user_scopes',
          'nivaro_api_keys',
          'nivaro_users',
          'nivaro_settings'
        ],
        // Sign-ins land on nivaro_users too; they are not permission changes.
        exclude_actions: ['login', 'logout', 'login-refused'],
        range: 'last_7_days'
      }),
      schedule: null,
      recipients: '[]'
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) await knex.schema.dropTable(TABLE)
}
