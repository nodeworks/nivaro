import type { Knex } from 'knex'

/**
 * What they saw when notified (#1385).
 *   - nivaro_notifications.revision_id (int NULL, NO FK): the nivaro_revisions
 *     id current for the record the notification names at the moment it was
 *     written. notifyUser stamps it; the "as it was" view opens that snapshot
 *     beside the record as it is now. No FK on purpose — revisions are
 *     purged by retention, and a purged snapshot must never block a row
 *     write or delete. A NULL (older row, purged revision) falls back to the
 *     newest revision before the notification's timestamp at read time.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_notifications'))) return
  if (!(await knex.schema.hasColumn('nivaro_notifications', 'revision_id'))) {
    await knex.schema.alterTable('nivaro_notifications', (t) => {
      t.integer('revision_id').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_notifications'))) return
  if (await knex.schema.hasColumn('nivaro_notifications', 'revision_id')) {
    await knex.schema.alterTable('nivaro_notifications', (t) => {
      t.dropColumn('revision_id')
    })
  }
}
