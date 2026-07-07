import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_activity', (t) => {
    // directus_activity.id this row was imported from; NULL = organic row.
    t.integer('legacy_id').nullable()
  })
  await knex.schema.alterTable('nivaro_revisions', (t) => {
    // directus_revisions.id this row was imported from; NULL = organic row.
    t.integer('legacy_id').nullable()
  })
  await knex.schema.alterTable('nivaro_workflow_history', (t) => {
    // directus_activity.id of the legacy revision that produced this transition.
    t.integer('legacy_activity_id').nullable()
  })
  // Filtered unique indexes: enforce no-duplicate-import, back the NOT EXISTS
  // incremental checks, and ignore the NULLs on organic rows.
  await knex.raw(
    'CREATE UNIQUE INDEX ux_nivaro_activity_legacy_id ON nivaro_activity (legacy_id) WHERE legacy_id IS NOT NULL'
  )
  await knex.raw(
    'CREATE UNIQUE INDEX ux_nivaro_revisions_legacy_id ON nivaro_revisions (legacy_id) WHERE legacy_id IS NOT NULL'
  )
  await knex.raw(
    'CREATE UNIQUE INDEX ux_nivaro_wf_history_legacy_activity_id ON nivaro_workflow_history (legacy_activity_id) WHERE legacy_activity_id IS NOT NULL'
  )
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX ux_nivaro_activity_legacy_id ON nivaro_activity')
  await knex.raw('DROP INDEX ux_nivaro_revisions_legacy_id ON nivaro_revisions')
  await knex.raw('DROP INDEX ux_nivaro_wf_history_legacy_activity_id ON nivaro_workflow_history')
  await knex.schema.alterTable('nivaro_activity', (t) => {
    t.dropColumn('legacy_id')
  })
  await knex.schema.alterTable('nivaro_revisions', (t) => {
    t.dropColumn('legacy_id')
  })
  await knex.schema.alterTable('nivaro_workflow_history', (t) => {
    t.dropColumn('legacy_activity_id')
  })
}
