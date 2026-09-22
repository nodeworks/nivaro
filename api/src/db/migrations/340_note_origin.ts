import type { Knex } from 'knex'

/**
 * nivaro_activity.origin + nivaro_workflow_history.origin (#518).
 *
 * Machine-written history (legacy import, reforecast, state sync, import
 * stamps) was kept out of the Notes thread by REGEX over the comment text —
 * a new machine writer whose marker nobody registered read as a person. The
 * writer now states what it is: person | machine | import | integration.
 * NULL on historic rows = unknown; readers fall back to the text markers.
 */
const TABLES = ['nivaro_activity', 'nivaro_workflow_history'] as const

export async function up(knex: Knex): Promise<void> {
  for (const t of TABLES) {
    if (!(await knex.schema.hasTable(t))) continue
    if (!(await knex.schema.hasColumn(t, 'origin'))) {
      await knex.schema.alterTable(t, (tb) => {
        tb.string('origin', 20).nullable()
      })
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const t of TABLES) {
    if (await knex.schema.hasColumn(t, 'origin')) {
      await knex.schema.alterTable(t, (tb) => {
        tb.dropColumn('origin')
      })
    }
  }
}
