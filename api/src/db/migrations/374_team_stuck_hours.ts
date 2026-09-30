import type { Knex } from 'knex'

/**
 * nivaro_settings.team_stuck_hours — how long an open record may sit in one
 * state before a manager's team view counts it as stuck (#1031). NULL = 240
 * hours (ten days). Edited in Settings; read by services/team.ts.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_settings'))) return
  if (await knex.schema.hasColumn('nivaro_settings', 'team_stuck_hours')) return
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.integer('team_stuck_hours').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_settings'))) return
  if (await knex.schema.hasColumn('nivaro_settings', 'team_stuck_hours')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('team_stuck_hours')
    })
  }
}
