import type { Knex } from 'knex'
import { isMssql } from '../dialect.js'

/**
 * Teams bot foundation (spec 2026-10-27-teams-bot §4).
 *  - nivaro_users.entra_oid / entra_tid: the Entra object id + tenant id the
 *    ID token carried at sign-in (Microsoft's `sub` is per application, not
 *    the object id). Filtered unique index on entra_oid WHERE NOT NULL.
 *  - nivaro_teams_links: one row per Teams person linked to a Nivaro user.
 *    user_id is uuid -> nivaro_users.id, NO ACTION. Timestamps are written
 *    from JS as UTC.
 *  - nivaro_settings: teams_bot_enabled / app_id / app_secret / tenant_id / app_type
 *    (MultiTenant | SingleTenant; null = MultiTenant).
 * Guarded + additive; down() drops only what up() added. T-SQL (sys.* reads,
 * filtered index, datetime2) runs on SQL Server only; elsewhere a plain unique
 * index does the same job (Postgres / MySQL unique indexes allow many NULLs).
 */
const USERS = 'nivaro_users'
const LINKS = 'nivaro_teams_links'
const SETTINGS = 'nivaro_settings'
const OID_INDEX = 'ux_nivaro_users_entra_oid'

export async function up(knex: Knex): Promise<void> {
  const mssql = isMssql(knex)
  if (await knex.schema.hasTable(USERS)) {
    let addedOid = false
    if (!(await knex.schema.hasColumn(USERS, 'entra_oid'))) {
      await knex.schema.alterTable(USERS, (t) => {
        t.string('entra_oid', 64).nullable()
      })
      addedOid = true
    }
    if (!(await knex.schema.hasColumn(USERS, 'entra_tid'))) {
      await knex.schema.alterTable(USERS, (t) => {
        t.string('entra_tid', 64).nullable()
      })
    }
    if (mssql) {
      await knex.raw(
        `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${OID_INDEX}' AND object_id = OBJECT_ID('${USERS}'))
         CREATE UNIQUE INDEX [${OID_INDEX}] ON [${USERS}] ([entra_oid]) WHERE [entra_oid] IS NOT NULL`
      )
    } else if (addedOid) {
      await knex.schema.alterTable(USERS, (t) => {
        t.unique(['entra_oid'], { indexName: OID_INDEX })
      })
    }
  }

  if (!(await knex.schema.hasTable(LINKS))) {
    const stamp = (t: Knex.CreateTableBuilder, name: string) =>
      mssql ? t.specificType(name, 'datetime2').nullable() : t.timestamp(name).nullable()
    await knex.schema.createTable(LINKS, (t) => {
      t.increments('id').primary()
      t.uuid('user_id').notNullable().references('id').inTable(USERS).onDelete('NO ACTION')
      t.string('aad_object_id', 64).notNullable().unique()
      t.string('tenant_id', 64).notNullable()
      t.string('conversation_id', 400).nullable()
      t.string('service_url', 400).nullable()
      t.string('status', 20).notNullable().defaultTo('active') // active | uninstalled | blocked | unlinked
      t.string('linked_by', 20).notNullable() // entra_oid | sign_in
      stamp(t, 'installed_at')
      stamp(t, 'linked_at')
      stamp(t, 'last_inbound_at')
      stamp(t, 'last_sent_at')
      t.string('last_error', 500).nullable()
      t.index(['user_id'], 'ix_nivaro_teams_links_user')
    })
  }

  if (await knex.schema.hasTable(SETTINGS)) {
    const cols: Array<[string, (t: Knex.AlterTableBuilder) => void]> = [
      ['teams_bot_enabled', (t) => void t.boolean('teams_bot_enabled').defaultTo(false)],
      ['teams_bot_app_id', (t) => void t.string('teams_bot_app_id', 100).nullable()],
      ['teams_bot_app_secret', (t) => void t.text('teams_bot_app_secret', 'longtext').nullable()],
      ['teams_bot_tenant_id', (t) => void t.string('teams_bot_tenant_id', 64).nullable()],
      ['teams_bot_app_type', (t) => void t.string('teams_bot_app_type', 20).nullable()]
    ]
    for (const [name, add] of cols) {
      if (await knex.schema.hasColumn(SETTINGS, name)) continue
      await knex.schema.alterTable(SETTINGS, add)
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(SETTINGS)) {
    for (const name of [
      'teams_bot_app_type',
      'teams_bot_tenant_id',
      'teams_bot_app_secret',
      'teams_bot_app_id',
      'teams_bot_enabled'
    ]) {
      if (!(await knex.schema.hasColumn(SETTINGS, name))) continue
      // teams_bot_enabled carries a default constraint that must go first
      if (name === 'teams_bot_enabled' && isMssql(knex)) {
        await knex.raw(
          `DECLARE @c nvarchar(256) = (SELECT dc.name FROM sys.default_constraints dc
             JOIN sys.columns c ON c.default_object_id = dc.object_id
             WHERE dc.parent_object_id = OBJECT_ID('${SETTINGS}') AND c.name = 'teams_bot_enabled');
           IF @c IS NOT NULL EXEC('ALTER TABLE [${SETTINGS}] DROP CONSTRAINT [' + @c + ']')`
        )
      }
      await knex.schema.alterTable(SETTINGS, (t) => {
        t.dropColumn(name)
      })
    }
  }

  await knex.schema.dropTableIfExists(LINKS)

  if (await knex.schema.hasTable(USERS)) {
    if (isMssql(knex)) {
      await knex.raw(
        `IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${OID_INDEX}' AND object_id = OBJECT_ID('${USERS}'))
         DROP INDEX [${OID_INDEX}] ON [${USERS}]`
      )
    }
    for (const name of ['entra_tid', 'entra_oid']) {
      if (!(await knex.schema.hasColumn(USERS, name))) continue
      await knex.schema.alterTable(USERS, (t) => {
        t.dropColumn(name)
      })
    }
  }
}
