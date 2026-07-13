import type { Knex } from 'knex'

/**
 * AI action proposals — the chat can PROPOSE mutations (bulk field updates,
 * record creation) but never executes them: a proposal row is created with a
 * preview of affected records, and only an explicit user approval executes
 * it through the items service (full RBAC/RLS/hooks/validation/activity).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_ai_proposals', (t) => {
    t.uuid('id').primary()
    t.uuid('user').notNullable().references('id').inTable('nivaro_users')
    t.string('action_type', 30).notNullable() // bulk_update | create_record
    t.string('collection', 255).notNullable()
    t.text('payload').notNullable() // JSON: {ids, changes} | {data}
    t.text('preview').notNullable() // JSON: {count, sample:[{id,label}], changes}
    t.string('status', 20).notNullable().defaultTo('proposed')
    t.text('result') // JSON: {updated, failed, errors[]} | {id}
    t.datetime('created_at').defaultTo(knex.fn.now())
    t.datetime('executed_at')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('nivaro_ai_proposals')
}
