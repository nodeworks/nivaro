import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub: app templates (Hub enhancement 24). Created on every install, used only in hub
 * mode. No foreign keys; each table is skipped when it already exists.
 *
 *  - nivaro_hub_app_templates      the template library: one row per uploaded App Blueprint
 *                                  (bare blueprint or published package) with a name, description
 *                                  and version. `bundle` is the package as stored (immutable after
 *                                  upload), `digest` its sha256, `manifest` the counts shown in the
 *                                  library; `archived_at` hides it from Create app.
 *  - nivaro_hub_template_installs  one row per environment a creation installs a template into
 *                                  (status pending|installing|done|failed), the app's install
 *                                  report and a short note.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_hub_app_templates'))) {
    await knex.schema.createTable('nivaro_hub_app_templates', (t) => {
      t.increments('id').primary()
      t.string('name', 120).notNullable()
      t.string('version', 40).notNullable()
      t.string('description', 1000).nullable()
      longText(t, knex, 'bundle').notNullable()
      t.string('digest', 80).notNullable()
      t.integer('size_bytes').notNullable().defaultTo(0)
      longText(t, knex, 'manifest').nullable()
      t.dateTime('archived_at').nullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.unique(['name', 'version'], { indexName: 'ux_nivaro_hub_app_templates_nv' })
    })
  }

  if (!(await knex.schema.hasTable('nivaro_hub_template_installs'))) {
    await knex.schema.createTable('nivaro_hub_template_installs', (t) => {
      t.increments('id').primary()
      t.integer('app_id').notNullable()
      t.integer('environment_id').notNullable()
      t.integer('template_id').notNullable()
      t.string('status', 16).notNullable().defaultTo('pending')
      t.string('note', 500).nullable()
      longText(t, knex, 'report').nullable()
      t.uuid('created_by').nullable()
      t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
      t.dateTime('finished_at').nullable()
      t.unique(['environment_id'], { indexName: 'ux_nivaro_hub_tpl_installs_env' })
      t.index(['template_id'], 'ix_nivaro_hub_tpl_installs_tpl')
    })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: tables may hold live hub data.
}
