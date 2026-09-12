import type { Knex } from 'knex'

/**
 * Bulk actions registry: admin-defined actions run over a selection in the
 * collection browser or a queue — write fields or run a pipeline transition
 * by label — with a per-record guard, per-action access (everyone / admins /
 * roles), an optional required reason and confirm text. Surfaces pick which
 * enabled actions they show (browser_config.bulk_actions,
 * display_config.bulk_action_keys). See routes/bulk-actions.ts.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_bulk_actions'))) {
    await knex.schema.createTable('nivaro_bulk_actions', (t) => {
      t.increments('id').primary()
      t.string('collection', 255).notNullable()
      t.string('key', 80).notNullable()
      t.string('label', 120).notNullable()
      t.string('icon', 60).nullable()
      t.string('variant', 20).notNullable().defaultTo('default') // 'default' | 'danger'
      t.string('kind', 30).notNullable() // 'update_fields' | 'transition'
      t.text('config').notNullable() // JSON per kind — see routes/bulk-actions.ts
      t.text('guard').nullable() // JSON [{field, op, value}] AND — record skipped when unmet
      t.text('access').nullable() // JSON {mode: 'everyone'|'admin'|'roles', role_ids: []}
      t.boolean('require_reason').notNullable().defaultTo(false)
      t.string('confirm_text', 500).nullable()
      t.boolean('is_active').notNullable().defaultTo(true)
      t.integer('sort').notNullable().defaultTo(0)
      t.uuid('created_by').nullable().references('id').inTable('nivaro_users')
      t.datetime('created_at').notNullable().defaultTo(knex.fn.now())
      t.unique(['collection', 'key'])
      t.index(['collection'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_bulk_actions')
}
