import type { Knex } from 'knex'

export async function up(knex: Knex) {
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.specificType('teams_webhook_url', 'nvarchar(500)').nullable().defaultTo(null)
    t.specificType('ad_group_role_map', 'nvarchar(max)').nullable().defaultTo(null) // JSON: [{ad_group_id, role_id}]
  })
}

export async function down(knex: Knex) {
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.dropColumn('teams_webhook_url')
    t.dropColumn('ad_group_role_map')
  })
}
