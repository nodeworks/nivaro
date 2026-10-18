import type { Knex } from 'knex'

/**
 * Migration 453 — which browser, OS and screen a real-user timing came from (Traffic Map #2191).
 *
 * `nivaro_rum_events` gains three short, bucketed columns: `browser` ('Chrome 126'),
 * `os` ('macOS'), `screen` ('laptop' — a width class, never the exact size). The intake route
 * reads them off the User-Agent header and the beacon's viewport width; no fingerprint, no
 * identifiers. Additive and guarded; the intake probes the columns, so an unmigrated tenant keeps
 * writing.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_rum_events'))) return
  for (const [col, len] of [
    ['browser', 40],
    ['os', 30],
    ['screen', 20]
  ] as const) {
    if (!(await knex.schema.hasColumn('nivaro_rum_events', col))) {
      await knex.schema.alterTable('nivaro_rum_events', (t) => {
        t.string(col, len).nullable()
      })
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_rum_events'))) return
  for (const col of ['browser', 'os', 'screen']) {
    if (await knex.schema.hasColumn('nivaro_rum_events', col)) {
      await knex.schema.alterTable('nivaro_rum_events', (t) => {
        t.dropColumn(col)
      })
    }
  }
}
