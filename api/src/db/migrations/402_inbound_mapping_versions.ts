import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Inbound mapping versions (#1266) — every save of an inbound mapping (rules,
 * children, fixtures, response template, status map) keeps a snapshot of the
 * whole mapping row, ids included, so an edit can be diffed and undone.
 *   - mapping_id: FK → nivaro_inbound_mappings NO ACTION — the mapping DELETE
 *     route clears its versions first.
 *   - version: 1, 2, … per mapping; UNIQUE(mapping_id, version).
 *   - snapshot: JSON of the mapping row (services/inbound-mapping-versions.ts).
 *   - created_by: bare uuid FK → nivaro_users NO ACTION.
 * Content-deduped against the newest version and pruned to the newest 30.
 */
const TABLE = 'nivaro_inbound_mapping_versions'

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_inbound_mappings'))) return
  if (await knex.schema.hasTable(TABLE)) return
  await knex.schema.createTable(TABLE, (t) => {
    t.increments('id').primary()
    t.integer('mapping_id')
      .notNullable()
      .references('id')
      .inTable('nivaro_inbound_mappings')
      .onDelete('NO ACTION')
    t.integer('version').notNullable()
    t.text('snapshot').notNullable()
    t.string('note', 255).nullable()
    t.uuid('created_by').nullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
    t.datetime('created_at').notNullable().defaultTo(utcNow(knex))
    t.unique(['mapping_id', 'version'], { indexName: 'ux_inbound_mapping_versions' })
  })
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) await knex.schema.dropTable(TABLE)
}
