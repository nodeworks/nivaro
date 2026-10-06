import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Owner matrix versions (#833) — id-preserving snapshots of a template's
 * owner dimensions, owner groups (filters, priority, max_wip…), group members
 * and team links. Template versions (nivaro_workflow_template_versions) cover
 * states/transitions/bindings only; the matrix churns far more and is far
 * bigger (~4,000 groups on a busy template), so it gets its own table: the
 * snapshot is gzip+base64 when large (`gz:` prefix), content_hash makes the
 * dedupe a string compare, pruned to the newest 30 per template.
 */
const TABLE = 'nivaro_owner_matrix_versions'

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) return
  await knex.schema.createTable(TABLE, (t) => {
    t.increments('id').primary()
    // NO ACTION per the MSSQL FK rules — the template delete route removes
    // matrix versions alongside its template versions.
    t.uuid('template')
      .notNullable()
      .references('id')
      .inTable('nivaro_workflow_templates')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.integer('version').notNullable()
    t.text('snapshot').notNullable()
    t.string('content_hash', 64).notNullable()
    t.integer('bytes')
    t.integer('group_count')
    t.integer('member_count')
    t.string('note', 255)
    t.uuid('created_by').references('id').inTable('nivaro_users').onDelete('NO ACTION')
    t.datetime('created_at').notNullable().defaultTo(utcNow(knex))
    t.unique(['template', 'version'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(TABLE)
}
