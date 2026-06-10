import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.string('smtp_host', 255).nullable()
    t.integer('smtp_port').nullable()
    t.string('smtp_user', 255).nullable()
    t.string('smtp_pass', 500).nullable()
    t.string('smtp_from', 255).nullable()
    t.specificType('smtp_secure', 'bit').nullable() // 1 = TLS, 0 = plain
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.dropColumn('smtp_host')
    t.dropColumn('smtp_port')
    t.dropColumn('smtp_user')
    t.dropColumn('smtp_pass')
    t.dropColumn('smtp_from')
    t.dropColumn('smtp_secure')
  })
}
