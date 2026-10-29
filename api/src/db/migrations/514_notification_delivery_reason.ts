import type { Knex } from 'knex'

/**
 * Migration 514 — "Why did I get this?" (#3078).
 *
 *   nivaro_notifications.delivery_reason  nvarchar(max) NULL — JSON written when the row is
 *     written: the path that sent it ({kind, text, label, id}: record watch, subscription,
 *     owner of the state, @mention, alert subscription, role default…), the category, which
 *     rules layer decided each channel (person / role default / system default, #3077) and the
 *     rules that picked each channel (category rule, quiet hours…). The escalation cron appends
 *     each unread-escalation step it fires. What HAPPENED, never a re-simulation; NULL = a row
 *     written before reasons were recorded. services/notification-reason.ts owns the shape.
 *
 * Nullable column, no default: a metadata-only change on SQL Server. Writers column-probe it,
 * so an image ahead of this ledger keeps writing rows without it. Guarded + additive.
 */
const TABLE = 'nivaro_notifications'

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (!(await knex.schema.hasColumn(TABLE, 'delivery_reason'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.text('delivery_reason').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (await knex.schema.hasColumn(TABLE, 'delivery_reason')) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.dropColumn('delivery_reason')
    })
  }
}
