import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Reusable layout blocks (#2594 layout templates, #2606 section library).
 *
 * One row per saved block: a whole form ('form') or one section with its tabs
 * ('section'). `payload` is JSON holding groups and placements by FIELD NAME
 * (never row ids), so a block drops into any layout of any collection; a
 * different collection maps the names first (services/layout-blocks.ts).
 * `created_by` / `workspace` are bare uuids (no FK): a deleted admin or
 * workspace must never block a read. Configuration, so promoted with layouts.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_layout_templates')) return
  await knex.schema.createTable('nivaro_layout_templates', (t) => {
    t.increments('id')
    t.string('kind', 16).notNullable() // form | section
    t.string('name', 200).notNullable()
    t.text('description').nullable()
    t.string('source_collection', 255).nullable()
    t.text('payload').notNullable() // JSON LayoutBlock
    t.uuid('created_by').nullable()
    t.uuid('workspace').nullable()
    t.datetime('created_at').notNullable().defaultTo(utcNow(knex))
    t.datetime('updated_at').notNullable().defaultTo(utcNow(knex))
    t.index(['kind', 'name'], 'ix_layout_templates_kind')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_layout_templates')
}
