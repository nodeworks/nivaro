import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('nivaro_push_subscriptions', (t) => {
    t.increments('id').primary()
    t.uuid('user').notNullable().references('id').inTable('nivaro_users').onDelete('CASCADE')
    t.string('endpoint', 1000).notNullable()
    // Unique index on the full endpoint would blow MSSQL's 900-byte key cap
    t.string('endpoint_hash', 64).notNullable().unique()
    t.string('keys_p256dh', 255).notNullable()
    t.string('keys_auth', 255).notNullable()
    t.string('user_agent', 500).nullable()
    t.dateTime('created_at').notNullable().defaultTo(knex.fn.now())
    t.dateTime('last_used_at').nullable()
    t.index(['user'])
  })

  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.string('vapid_public_key', 255).nullable()
    t.string('vapid_private_key', 255).nullable()
    t.string('vapid_subject', 255).nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_push_subscriptions')
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.dropColumn('vapid_public_key')
    t.dropColumn('vapid_private_key')
    t.dropColumn('vapid_subject')
  })
}
