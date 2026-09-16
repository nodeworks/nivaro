import type { Knex } from 'knex'

/**
 * Reports batch — #70 "only if changed" report subscriptions. A subscriber
 * may ask for the digest only when the report's numbers moved since the
 * last delivery; the hash of the last delivered snapshot is what the next
 * run compares against. Additive and guarded.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_report_subscriptions'))) return
  if (!(await knex.schema.hasColumn('nivaro_report_subscriptions', 'only_if_changed'))) {
    await knex.schema.alterTable('nivaro_report_subscriptions', (t) => {
      t.boolean('only_if_changed').notNullable().defaultTo(false)
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_report_subscriptions', 'last_snapshot_hash'))) {
    await knex.schema.alterTable('nivaro_report_subscriptions', (t) => {
      t.string('last_snapshot_hash', 64).nullable()
      t.dateTime('last_skipped_at').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_report_subscriptions'))) return
  for (const col of ['only_if_changed', 'last_snapshot_hash', 'last_skipped_at']) {
    if (await knex.schema.hasColumn('nivaro_report_subscriptions', col)) {
      await knex.schema.alterTable('nivaro_report_subscriptions', (t) => {
        t.dropColumn(col)
      })
    }
  }
}
