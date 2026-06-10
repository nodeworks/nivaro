import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  // 2FA / contact fields on users (separate alterTable per column — MSSQL reliability)
  await knex.schema.alterTable('nivaro_users', (t) => {
    t.string('totp_secret', 255).nullable()
  })
  await knex.schema.alterTable('nivaro_users', (t) => {
    t.boolean('totp_enabled').notNullable().defaultTo(false)
  })
  await knex.schema.alterTable('nivaro_users', (t) => {
    t.string('phone', 50).nullable()
  })

  await knex.schema.createTable('nivaro_api_keys', (t) => {
    t.increments('id')
    t.string('name', 255).notNullable()
    t.string('key_hash', 255).notNullable()
    t.string('prefix', 20).notNullable()
    t.uuid('user').notNullable()
    t.foreign('user')
      .references('id')
      .inTable('nivaro_users')
      .onDelete('NO ACTION')
      .onUpdate('NO ACTION')
    t.specificType('scopes', 'nvarchar(max)').notNullable() // JSON array
    t.datetime('expires_at').nullable()
    t.integer('rate_limit_per_minute').nullable()
    t.specificType('ip_allowlist', 'nvarchar(max)').nullable()
    t.datetime('last_used_at').nullable()
    t.boolean('is_active').notNullable().defaultTo(true)
    t.datetime('created_at').defaultTo(knex.fn.now())
  })
  await knex.raw(
    'ALTER TABLE nivaro_api_keys ADD CONSTRAINT uq_nivaro_api_keys_key_hash UNIQUE (key_hash)'
  )

  await knex.schema.alterTable('nivaro_fields', (t) => {
    t.boolean('is_encrypted').notNullable().defaultTo(false)
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_fields', (t) => {
    t.dropColumn('is_encrypted')
  })
  await knex.schema.dropTableIfExists('nivaro_api_keys')
  await knex.schema.alterTable('nivaro_users', (t) => {
    t.dropColumn('phone')
  })
  await knex.schema.alterTable('nivaro_users', (t) => {
    t.dropColumn('totp_enabled')
  })
  await knex.schema.alterTable('nivaro_users', (t) => {
    t.dropColumn('totp_secret')
  })
}
