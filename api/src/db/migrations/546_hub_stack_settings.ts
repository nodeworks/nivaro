import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'
import { longText } from '../portable-ddl.js'

/**
 * Nivaro Hub phase 4: per-environment stack settings (size, Redis mode, publish port, plain
 * settings, one sealed secrets object). Created on every install, used only in hub mode.
 * No foreign key; skipped when it already exists.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_hub_stack_settings')) return
  await knex.schema.createTable('nivaro_hub_stack_settings', (t) => {
    t.increments('id').primary()
    t.integer('environment_id').notNullable()
    t.string('size', 16).notNullable().defaultTo('small')
    t.string('redis', 16).notNullable().defaultTo('bundled')
    t.integer('publish_port').nullable()
    longText(t, knex, 'settings').nullable()
    longText(t, knex, 'secrets').nullable()
    t.dateTime('created_at').nullable().defaultTo(utcNow(knex))
    t.dateTime('updated_at').nullable().defaultTo(utcNow(knex))
    t.unique(['environment_id'], { indexName: 'ux_nivaro_hub_stack_env' })
  })
}

export async function down(): Promise<void> {
  // Nothing to undo: the table may hold live hub data.
}
