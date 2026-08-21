import type { Knex } from 'knex'

/**
 * Custom action buttons (#39): admin-defined no-code record buttons — run a
 * flow, call an external API endpoint, or write fields — with guard
 * conditions and confirm text. The no-code counterpart of extension item
 * actions.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_custom_actions'))) {
    await knex.schema.createTable('nivaro_custom_actions', (t) => {
      t.increments('id').primary()
      t.string('collection', 255).notNullable()
      t.string('label', 120).notNullable()
      t.string('action_type', 30).notNullable() // 'flow' | 'external_api' | 'update_fields'
      t.text('config').notNullable() // JSON per type — see routes/custom-actions.ts
      t.text('guard').nullable() // JSON [{field, op, value}] AND — hidden when unmet
      t.string('confirm_text', 500).nullable()
      t.boolean('is_active').notNullable().defaultTo(true)
      t.integer('sort').notNullable().defaultTo(0)
      t.uuid('created_by').nullable().references('id').inTable('nivaro_users')
      t.datetime('created_at').notNullable().defaultTo(knex.fn.now())
      t.index(['collection'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_custom_actions')
}
