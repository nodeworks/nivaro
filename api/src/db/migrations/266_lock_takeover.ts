import type { Knex } from 'knex'

// Security sprint: which roles may force-take edit locks (#256).
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'lock_takeover_roles'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('lock_takeover_roles').nullable() // JSON role-id array
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'lock_takeover_roles')) {
    await knex.schema.alterTable('nivaro_settings', (t) => t.dropColumn('lock_takeover_roles'))
  }
}
