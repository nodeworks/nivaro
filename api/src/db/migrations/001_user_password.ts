import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_users', 'password_hash')
  if (!has) {
    await knex.schema.alterTable('nivaro_users', (t) => {
      t.string('password_hash', 500).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_users', 'password_hash')
  if (has) {
    await knex.schema.alterTable('nivaro_users', (t) => {
      t.dropColumn('password_hash')
    })
  }
}
