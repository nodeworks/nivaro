import type { Knex } from 'knex'

/**
 * Round-2 sprint batch:
 *  - nivaro_mail_log             — every outbound send attempt (#71)
 *  - nivaro_collection_snapshots — reference-table checkpoints (#78)
 *  - nivaro_export_presets       — named export configurations (#85)
 *  - nivaro_workflow_states.description       — per-state help text (#81)
 *  - nivaro_announcements.require_ack         — must-acknowledge broadcasts (#90)
 *  - nivaro_collections.delete_guard          — deletion protection rules (#64)
 *  - nivaro_api_logs.api_key_id               — per-key API analytics (#67)
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_mail_log'))) {
    await knex.schema.createTable('nivaro_mail_log', (t) => {
      t.increments('id').primary()
      t.string('to', 1000).notNullable()
      t.string('subject', 500).nullable()
      t.string('template', 120).nullable()
      t.string('status', 20).notNullable() // 'sent' | 'failed' | 'dropped' | 'deferred'
      t.text('error').nullable()
      t.text('body').nullable() // rendered html (capped) — powers resend
      t.datetime('created_at').notNullable().defaultTo(knex.fn.now())
      t.index(['created_at'])
    })
  }

  if (!(await knex.schema.hasTable('nivaro_collection_snapshots'))) {
    await knex.schema.createTable('nivaro_collection_snapshots', (t) => {
      t.increments('id').primary()
      t.string('collection', 255).notNullable()
      t.string('name', 200).notNullable()
      t.integer('row_count').notNullable()
      t.text('data').notNullable() // JSON array of rows (capped at snapshot time)
      t.uuid('created_by').nullable().references('id').inTable('nivaro_users')
      t.datetime('created_at').notNullable().defaultTo(knex.fn.now())
      t.index(['collection'])
    })
  }

  if (!(await knex.schema.hasTable('nivaro_export_presets'))) {
    await knex.schema.createTable('nivaro_export_presets', (t) => {
      t.increments('id').primary()
      t.string('collection', 255).notNullable()
      t.string('name', 200).notNullable()
      t.text('config').notNullable() // JSON {columns: [...], format: 'csv'|'xlsx'}
      t.boolean('is_shared').notNullable().defaultTo(true)
      t.uuid('created_by').nullable().references('id').inTable('nivaro_users')
      t.datetime('created_at').notNullable().defaultTo(knex.fn.now())
      t.index(['collection'])
    })
  }

  if (!(await knex.schema.hasColumn('nivaro_workflow_states', 'description'))) {
    await knex.schema.alterTable('nivaro_workflow_states', (t) => {
      t.string('description', 1000).nullable()
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_announcements', 'require_ack'))) {
    await knex.schema.alterTable('nivaro_announcements', (t) => {
      t.boolean('require_ack').notNullable().defaultTo(false)
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_collections', 'delete_guard'))) {
    await knex.schema.alterTable('nivaro_collections', (t) => {
      t.text('delete_guard').nullable()
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_api_logs', 'api_key_id'))) {
    await knex.schema.alterTable('nivaro_api_logs', (t) => {
      t.integer('api_key_id').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_mail_log')
  await knex.schema.dropTableIfExists('nivaro_collection_snapshots')
  await knex.schema.dropTableIfExists('nivaro_export_presets')
  await knex.schema.alterTable('nivaro_workflow_states', (t) => t.dropColumn('description'))
  await knex.schema.alterTable('nivaro_announcements', (t) => t.dropColumn('require_ack'))
  await knex.schema.alterTable('nivaro_collections', (t) => t.dropColumn('delete_guard'))
  await knex.schema.alterTable('nivaro_api_logs', (t) => t.dropColumn('api_key_id'))
}
