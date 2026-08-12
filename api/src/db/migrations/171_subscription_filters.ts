import type { Knex } from 'knex'

// Multi-dimension subscription filters (EFP notification-preferences parity):
// `filters` is a JSON array [{field, op, value}] AND-evaluated against the
// record at event time. `field` may be a plain column, dotted M2O path, or an
// M2M alias (resolves to the junction id array); ops: eq/in/intersects/null/
// nnull. Used together with event_type='workflow_transition' +
// filter_field='to_state' + filter_value=<state key> for state-scoped
// workflow notifications.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_notification_subscriptions', (t) => {
    t.text('filters').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_notification_subscriptions', (t) => {
    t.dropColumn('filters')
  })
}
