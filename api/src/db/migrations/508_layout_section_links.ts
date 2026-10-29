import type { Knex } from 'knex'
import { isMssql, utcNow } from '../dialect.js'

/**
 * Linked sections (#3194): a section from the section library
 * (nivaro_layout_templates kind 'section', migration 458) placed on a form as
 * LINKED. One row per (layout, group): the section with key `group_key` on
 * layout `layout_id` follows library section `template_id` — a library save
 * re-applies it to every linked form through the layout ops service, so each
 * form gets its own History entry.
 *
 * `field_map` is the JSON field mapping chosen when the section was placed on
 * a form of another collection (source field → target field, null = left
 * out). `confirmed_at` is set the first time the group is seen on the SAVED
 * layout (a linked drop sits in the editor's draft until Save); `synced_at`
 * is the last time a library save reached this form.
 *
 * No FKs (bare ints / uuid like nivaro_layout_templates): a deleted layout or
 * library section must never block a delete, and rows pointing at either are
 * pruned when read. Configuration: promoted with the layouts and templates.
 */
const TABLE = 'nivaro_layout_section_links'

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) return
  const mssql = isMssql(knex)
  await knex.schema.createTable(TABLE, (t) => {
    t.increments('id').primary()
    t.integer('template_id').notNullable()
    t.integer('layout_id').notNullable()
    t.string('group_key', 255).notNullable()
    // JSON text: nvarchar(max) on SQL Server, the dialect's long text elsewhere.
    if (mssql) t.specificType('field_map', 'nvarchar(max)').nullable()
    else t.text('field_map', 'longtext').nullable()
    t.uuid('created_by').nullable()
    ;(mssql ? t.specificType('created_at', 'datetime2') : t.timestamp('created_at'))
      .notNullable()
      .defaultTo(utcNow(knex))
    for (const name of ['confirmed_at', 'synced_at'])
      (mssql ? t.specificType(name, 'datetime2') : t.timestamp(name)).nullable()
    t.unique(['layout_id', 'group_key'], { indexName: 'ux_layout_section_links_group' })
    t.index(['template_id'], 'ix_layout_section_links_template')
  })
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) await knex.schema.dropTable(TABLE)
}
