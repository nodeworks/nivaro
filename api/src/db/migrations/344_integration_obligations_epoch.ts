import type { Knex } from 'knex'

/**
 * nivaro_settings.integration_obligations_epoch — the moment integration
 * obligations "started counting".
 *
 * Migration 343 created the ledger; the first reconcile sweep against an
 * EXISTING, years-old database would otherwise flood `missing` for every
 * MWF-linked workflow that was never pushed since records began (measured on
 * dev: 10,895 / 10,409 / 10,894 / 10,437 "behind" across the four MWF
 * workflow kinds — noise, not signal, since this database has almost no
 * accepted push history to compare against). A record whose relevant moment
 * (state entry, last edit, PO link — each kind names which) predates the
 * epoch is never flagged, however long ago the trigger that would have
 * pushed it never fired.
 *
 * Set to "now" once, at migration time, ONLY when NULL — so a re-run, or an
 * admin who already moved it (PATCH-allowlisted in routes/settings.ts), is
 * never stomped. Written as an explicit JS Date rather than GETDATE()/
 * GETUTCDATE() in SQL: GETDATE() is local server time, not UTC, and every
 * other timestamp this feature writes (recordObligation, resolveObligation)
 * goes through `new Date()` for the same reason — see docs/claude/
 * gotchas.md, "GETDATE() is LOCAL time; activity/revision timestamps are UTC".
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'integration_obligations_epoch'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dateTime('integration_obligations_epoch').nullable()
    })
  }
  await knex('nivaro_settings').whereNull('integration_obligations_epoch').update({
    integration_obligations_epoch: new Date()
  })
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'integration_obligations_epoch')) {
    await knex.schema.alterTable('nivaro_settings', (t) => t.dropColumn('integration_obligations_epoch'))
  }
}
