import type { Knex } from 'knex'

/**
 * Security center + maintenance mode. Login events capture every successful
 * sign-in (method, IP, agent) with a new-IP flag; maintenance bits on
 * settings gate writes instance-wide (admins exempt) with a banner.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_login_events'))) {
    await knex.schema.createTable('nivaro_login_events', (t) => {
      t.increments('id')
      t.uuid('user').notNullable()
      /** 'oidc' | 'password' | 'saml' | 'masquerade' */
      t.string('method', 20).notNullable()
      t.string('ip', 100).nullable()
      t.string('user_agent', 500).nullable()
      /** First time this IP was seen for this user in 90 days. */
      t.boolean('new_ip').notNullable().defaultTo(false)
      t.dateTime('created_at').notNullable()
      t.index(['user', 'id'])
      t.index(['created_at'])
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_settings', 'maintenance_mode'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.boolean('maintenance_mode').notNullable().defaultTo(false)
      t.string('maintenance_message', 500).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_login_events')
  if (await knex.schema.hasColumn('nivaro_settings', 'maintenance_mode')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('maintenance_mode')
      t.dropColumn('maintenance_message')
    })
  }
}
