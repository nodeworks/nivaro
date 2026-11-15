import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Migration 530 — reload trust (realtime ideas 14 + 15, 2026-11-14).
 *
 * 1. `nivaro_rum_events` gains how a page was reached (idea 15):
 *      nav_type    varchar(16)  navigate | reload | back_forward | prerender (null = older beacon)
 *      prev_route  varchar(300) the route pattern left behind, on back_forward only
 *      release     varchar(40)  the API version that took the beacon (per-release comparison)
 *    The intake probes `nav_type`, so an unmigrated tenant keeps writing (#2191 pattern).
 *
 * 2. `nivaro_missed_updates` — daily aggregates of the missed-update detector (idea 14). After a
 *    reload a screen compares field HASHES with what it showed before; a field that changed with
 *    no live event heard is a missed update. Names and counts only — never values:
 *      day         varchar(10)  UTC day YYYY-MM-DD
 *      kind        varchar(10)  missed | clean (a reload that compared records and found nothing)
 *      route       varchar(300) page route pattern
 *      collection  varchar(100) '' on clean rows
 *      field       varchar(100) '' on clean rows
 *      source      varchar(20)  delivery | procedure | raw | unknown ('' on clean rows)
 *      writer      varchar(120) the procedure / writer when one could be named ('' otherwise)
 *      hits        int          misses (missed) or reloads (clean)
 *      records     int          records compared (clean) / records affected (missed)
 *      gap_s_max   int          longest a stale value sat on screen (s)
 *      gap_s_sum   bigint       for the average
 *      sample_item varchar(255) the latest record id seen missing an update (admin drill-in)
 *      updated_at  datetime
 *    unique (day, kind, route, collection, field, source, writer) — the upsert key (1,320 bytes).
 *
 * Runtime tables (never copied by config promotion). Additive and guarded.
 */
const MISSED = 'nivaro_missed_updates'
const RUM = 'nivaro_rum_events'

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(RUM)) {
    for (const [col, len] of [
      ['nav_type', 16],
      ['prev_route', 300],
      ['release', 40]
    ] as const) {
      if (!(await knex.schema.hasColumn(RUM, col))) {
        await knex.schema.alterTable(RUM, (t) => {
          t.string(col, len).nullable()
        })
      }
    }
  }
  if (!(await knex.schema.hasTable(MISSED))) {
    await knex.schema.createTable(MISSED, (t) => {
      t.bigIncrements('id').primary()
      t.string('day', 10).notNullable()
      t.string('kind', 10).notNullable()
      t.string('route', 300).notNullable().defaultTo('')
      t.string('collection', 100).notNullable().defaultTo('')
      t.string('field', 100).notNullable().defaultTo('')
      t.string('source', 20).notNullable().defaultTo('')
      t.string('writer', 120).notNullable().defaultTo('')
      t.integer('hits').notNullable().defaultTo(0)
      t.integer('records').notNullable().defaultTo(0)
      t.integer('gap_s_max').notNullable().defaultTo(0)
      t.bigInteger('gap_s_sum').notNullable().defaultTo(0)
      t.string('sample_item', 255).nullable()
      t.datetime('updated_at').notNullable().defaultTo(utcNow(knex))
      t.unique(['day', 'kind', 'route', 'collection', 'field', 'source', 'writer'], {
        indexName: 'ux_missed_updates_key'
      })
      t.index(['day'], 'ix_missed_updates_day')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(MISSED)
  if (await knex.schema.hasTable(RUM)) {
    for (const col of ['nav_type', 'prev_route', 'release']) {
      if (await knex.schema.hasColumn(RUM, col)) {
        await knex.schema.alterTable(RUM, (t) => {
          t.dropColumn(col)
        })
      }
    }
  }
}
