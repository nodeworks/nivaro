import type { Knex } from 'knex'

// Per-user deferred email queue — users whose preferences.email_digest is
// 'daily' have individual notification emails captured here instead of sent;
// the daily action digest flushes them as one summary.
export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasTable('nivaro_deferred_emails')
  if (has) return
  await knex.schema.createTable('nivaro_deferred_emails', (t) => {
    t.increments('id')
    t.uuid('user').notNullable().references('id').inTable('nivaro_users').onDelete('CASCADE')
    t.string('email', 500).notNullable()
    t.string('subject', 500).notNullable()
    t.string('snippet', 2000).nullable()
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now())
    t.index(['user'], 'idx_deferred_emails_user')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_deferred_emails')
}
