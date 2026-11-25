import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub app lifecycle (Hub enhancements 46 + 47): app cloning and the retirement wizard.
 * Created on every install, used only in hub mode (HUB=on), empty otherwise. No foreign keys; each
 * table and column is skipped when it already exists; indexes are declared in createTable
 * (portable on all five engines). Additive only.
 *
 *  - nivaro_hub_clones       one row per structure captured from an app for a clone: the library
 *                            template it became (nivaro_hub_app_templates id), the source app,
 *                            environment and version, the counts, and the PATHS of the credential
 *                            values the source emptied (never a value)
 *  - nivaro_hub_retirements  one row per retirement of an app: the steps (freeze, export, notice,
 *                            remove, archive) with who signed each off and what it did, the plan
 *                            and its hash, the final notice, the freeze it holds
 *                            (nivaro_hub_freezes.source `retire:<id>`), the checklists it claimed,
 *                            and the runner's lease + heartbeat (resume after a stopped process)
 *  - nivaro_hub_apps.archived_at / archived_by   set by a retirement's last step
 *  - nivaro_hub_apps.retiring_id    the one open retirement of the app (set only where null)
 *  - nivaro_hub_template_installs.keep_admin_roles   role ids a creation keeps admin access for
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_hub_clones'))) {
    await knex.schema.createTable('nivaro_hub_clones', (t) => {
      t.increments('id').primary()
      t.integer('template_id').notNullable()
      t.integer('source_app_id').notNullable()
      t.integer('source_environment_id').notNullable()
      t.string('source_version', 64).nullable()
      longText(t, knex, 'counts').nullable()
      longText(t, knex, 'scrubbed').nullable()
      t.integer('scrubbed_count').notNullable().defaultTo(0)
      t.uuid('captured_by').nullable()
      t.dateTime('captured_at').nullable().defaultTo(utcNow(knex))
      t.index(['template_id'], 'ix_nivaro_hub_clones_template')
      t.index(['source_app_id', 'id'], 'ix_nivaro_hub_clones_source')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_retirements'))) {
    await knex.schema.createTable('nivaro_hub_retirements', (t) => {
      t.increments('id').primary()
      t.integer('app_id').notNullable()
      t.string('status', 16).notNullable().defaultTo('open')
      t.string('step', 24).nullable()
      longText(t, knex, 'steps').notNullable()
      longText(t, knex, 'plan').nullable()
      t.string('plan_hash', 64).nullable()
      longText(t, knex, 'notice').nullable()
      longText(t, knex, 'checklists').nullable()
      t.string('error', 1000).nullable()
      t.string('runner', 64).nullable()
      t.integer('rev').notNullable().defaultTo(0)
      t.dateTime('heartbeat_at').nullable()
      t.uuid('started_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('finished_at').nullable()
      t.index(['app_id', 'status'], 'ix_nivaro_hub_retirements_app')
      t.index(['status', 'heartbeat_at'], 'ix_nivaro_hub_retirements_live')
    })
  }

  if (
    (await knex.schema.hasTable('nivaro_hub_apps')) &&
    !(await knex.schema.hasColumn('nivaro_hub_apps', 'archived_at'))
  ) {
    await knex.schema.alterTable('nivaro_hub_apps', (t) => {
      t.dateTime('archived_at').nullable()
    })
  }
  if (
    (await knex.schema.hasTable('nivaro_hub_apps')) &&
    !(await knex.schema.hasColumn('nivaro_hub_apps', 'archived_by'))
  ) {
    await knex.schema.alterTable('nivaro_hub_apps', (t) => {
      t.uuid('archived_by').nullable()
    })
  }
  await upKeepAdmin(knex)
}

// Hub review M2: a template role with administrator access arrives WITHOUT it unless an
// administrator (on their own session) ticked "keep admin access" for it on Create app.
async function upKeepAdmin(knex: Knex): Promise<void> {
  if (
    (await knex.schema.hasTable('nivaro_hub_template_installs')) &&
    !(await knex.schema.hasColumn('nivaro_hub_template_installs', 'keep_admin_roles'))
  ) {
    await knex.schema.alterTable('nivaro_hub_template_installs', (t) => {
      longText(t, knex, 'keep_admin_roles').nullable()
    })
  }
  if (
    (await knex.schema.hasTable('nivaro_hub_apps')) &&
    !(await knex.schema.hasColumn('nivaro_hub_apps', 'retiring_id'))
  ) {
    // Review M3: the one open retirement of an app (compare-and-set where null).
    await knex.schema.alterTable('nivaro_hub_apps', (t) => {
      t.integer('retiring_id').nullable()
    })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: tables may hold live hub data.
}
