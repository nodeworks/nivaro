import type { Knex } from 'knex'

/**
 * "Dismiss" one occurrence of a Firefight problem (Task 15c) — a snooze
 * scoped to the row's CURRENT occurrence, not a time and not the payload
 * hash "Until it changes" already offers. `until_change_hash` masks digits
 * out of the row's title/group/detail, so a NEW failure carrying the same
 * wording ("Forecasts: last run failed — import_forecasts") never wakes it
 * back up. `until_occurrence` stores the identity of the specific instance
 * that was dismissed (a run id, a submission attempt, an obligation id...);
 * the row reappears the moment that identity changes, same as a notification
 * you can dismiss once but that fires again on the next real event.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_integration_signal_snoozes', 'until_occurrence'))) {
    await knex.schema.alterTable('nivaro_integration_signal_snoozes', (t) => {
      t.string('until_occurrence', 200).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_integration_signal_snoozes', 'until_occurrence')) {
    await knex.schema.alterTable('nivaro_integration_signal_snoozes', (t) => {
      t.dropColumn('until_occurrence')
    })
  }
}
