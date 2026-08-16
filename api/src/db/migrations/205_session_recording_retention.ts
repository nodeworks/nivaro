import type { Knex } from 'knex'

/**
 * How long session recordings are kept, in days.
 *
 * Was a constant, so changing it meant a code change and a deploy — for a
 * number that is a policy decision (how long is it reasonable to hold a
 * recording of someone working?) rather than an engineering one. Defaults to 7
 * so nothing changes for an existing instance.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'session_recording_retention_days')) return
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.integer('session_recording_retention_days').nullable().defaultTo(7)
  })
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'session_recording_retention_days'))) return
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.dropColumn('session_recording_retention_days')
  })
}
