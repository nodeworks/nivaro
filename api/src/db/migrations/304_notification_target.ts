import type { Knex } from 'knex'

/**
 * Contextual notifications: every row carries WHAT it is about (a structured
 * target — record / task / approval / chat room / queue / report …), the
 * action a click should offer, and the target kind for grouping. Written at
 * notify time; legacy rows are derived from collection + item + subject at
 * read time (services/notification-target.ts).
 */
export async function up(knex: Knex): Promise<void> {
  const t = 'nivaro_notifications'
  if (!(await knex.schema.hasColumn(t, 'target'))) {
    await knex.schema.alterTable(t, (tb) => {
      tb.text('target').nullable() // JSON NotificationTargetSpec
    })
  }
  if (!(await knex.schema.hasColumn(t, 'kind'))) {
    await knex.schema.alterTable(t, (tb) => {
      tb.string('kind', 40).nullable()
    })
  }
  if (!(await knex.schema.hasColumn(t, 'action'))) {
    await knex.schema.alterTable(t, (tb) => {
      tb.string('action', 40).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  const t = 'nivaro_notifications'
  for (const c of ['target', 'kind', 'action']) {
    if (await knex.schema.hasColumn(t, c)) {
      await knex.schema.alterTable(t, (tb) => {
        tb.dropColumn(c)
      })
    }
  }
}
