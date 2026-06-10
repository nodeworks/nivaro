import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  // Digest emails — batch notifications per subscription instead of per-event
  await knex.schema.alterTable('nivaro_notification_subscriptions', (t) => {
    t.string('digest_frequency', 10).notNullable().defaultTo('instant') // instant | daily | weekly
  })
  await knex.schema.alterTable('nivaro_users', (t) => {
    t.datetime('last_digest_at').nullable()
  })

  // Row-Level Security — per-policy row filter conditions (JSON)
  await knex.schema.alterTable('nivaro_policies', (t) => {
    t.specificType('row_filter', 'nvarchar(max)').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_policies', (t) => {
    t.dropColumn('row_filter')
  })
  await knex.schema.alterTable('nivaro_users', (t) => {
    t.dropColumn('last_digest_at')
  })
  await knex.schema.alterTable('nivaro_notification_subscriptions', (t) => {
    t.dropColumn('digest_frequency')
  })
}
