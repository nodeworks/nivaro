import type { Knex } from 'knex'
import { runLongSql } from '../../services/run-long.js'
import { isMssql } from '../dialect.js'

/**
 * Tamper-evident activity trail (#16) + retention made visible (#17).
 *
 *   nivaro_activity.seal_hash    char(64) NULL — sha256(previous seal_hash || canonical(row)),
 *                                hex. Written by the background sealer (cron activity-seal),
 *                                never on the write path. NULL = not sealed yet.
 *   nivaro_activity.seal_version tinyint NULL — which canonical form the hash covers
 *                                (services/activity-trail/canonical.ts; v1 = a fixed column list,
 *                                so columns later migrations add never change an old hash).
 *   nivaro_activity.seal_seq     bigint NULL — the row's position in the chain. Rows commit out
 *                                of id order (a long transaction), so the chain has its own order;
 *                                UNIQUE (filtered), so two sealers can never both claim a slot.
 *   ix_nivaro_activity_unsealed  (id) WHERE seal_hash IS NULL — the sealer's read. Holds every
 *                                row right after this migration, shrinks to ~nothing once the
 *                                backfill is through.
 *   ux_nivaro_activity_seal_seq  (seal_seq) INCLUDE (seal_hash) WHERE seal_seq IS NOT NULL —
 *                                chain walks (verify, evidence export, purge bridging).
 *
 *   nivaro_activity_seals        checkpoints: one row per verification run (daily cron
 *                                activity-trail-verify, or on demand). last_seq/last_hash = where
 *                                the verified chain stood; the next run restarts from the newest
 *                                good (or acknowledged) checkpoint, so a purge of rows below it
 *                                never matters.
 *   nivaro_activity_seal_bridges one row per surviving sealed row whose chain predecessor a
 *                                retention purge deleted: the predecessor's hash, so the link
 *                                still verifies. Written only by services/activity-trail/purge.ts.
 *
 * Legal holds (#17) already have their table (migration 235, nivaro_legal_holds: collection,
 * item_id, user, reason, placed_by, created_at, released_at, released_by) — nothing here.
 *
 * Promote-config: both new tables are instance data (SKIP). The columns are additive and
 * nullable (metadata-only on SQL Server). Each index reads nivaro_activity once while it builds,
 * on its own long request outside knex's batch transaction (migrations 502/512); writes to
 * nivaro_activity wait for each build (about a minute at 12M rows, Standard edition).
 */
export const config = { transaction: false }

const ACTIVITY = 'nivaro_activity'
const SEALS = 'nivaro_activity_seals'
const BRIDGES = 'nivaro_activity_seal_bridges'

export async function up(knex: Knex): Promise<void> {
  const mssql = isMssql(knex)
  if (await knex.schema.hasTable(ACTIVITY)) {
    if (!(await knex.schema.hasColumn(ACTIVITY, 'seal_hash'))) {
      await knex.schema.alterTable(ACTIVITY, (t) => {
        if (mssql) t.specificType('seal_hash', 'char(64)').nullable()
        else t.string('seal_hash', 64).nullable()
      })
    }
    if (!(await knex.schema.hasColumn(ACTIVITY, 'seal_version'))) {
      await knex.schema.alterTable(ACTIVITY, (t) => {
        t.tinyint('seal_version').nullable()
      })
    }
    if (!(await knex.schema.hasColumn(ACTIVITY, 'seal_seq'))) {
      await knex.schema.alterTable(ACTIVITY, (t) => {
        t.bigInteger('seal_seq').nullable()
      })
    }
    if (mssql) {
      await runLongSql(
        `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nivaro_activity_unsealed')
           CREATE INDEX ix_nivaro_activity_unsealed
             ON nivaro_activity (id)
             WHERE seal_hash IS NULL
             WITH (SORT_IN_TEMPDB = ON)`,
        { timeoutMs: 60 * 60 * 1000 }
      )
      await runLongSql(
        `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ux_nivaro_activity_seal_seq')
           CREATE UNIQUE INDEX ux_nivaro_activity_seal_seq
             ON nivaro_activity (seal_seq)
             INCLUDE (seal_hash)
             WHERE seal_seq IS NOT NULL
             WITH (SORT_IN_TEMPDB = ON)`,
        { timeoutMs: 60 * 60 * 1000 }
      )
    }
  }

  if (!(await knex.schema.hasTable(SEALS))) {
    await knex.schema.createTable(SEALS, (t) => {
      t.increments('id').primary()
      /** UTC day the checkpoint was taken. */
      t.date('seal_date').notNullable()
      /** daily | manual | full */
      t.string('kind', 20).notNullable()
      /** Chain position the walk started after (the previous checkpoint's last_seq; 0 = genesis). */
      t.bigInteger('from_seq').notNullable()
      t.bigInteger('last_seq').notNullable()
      t.integer('last_id').nullable()
      if (mssql) t.specificType('last_hash', 'char(64)').notNullable()
      else t.string('last_hash', 64).notNullable()
      /** Timestamp of the row at last_seq ("intact through"). */
      t.datetime('last_row_at').nullable()
      /** Rows walked in this run. */
      t.integer('row_count').notNullable().defaultTo(0)
      t.integer('bridged_count').notNullable().defaultTo(0)
      t.integer('mismatch_count').notNullable().defaultTo(0)
      t.datetime('verified_at').notNullable()
      t.boolean('verified_ok').notNullable()
      t.integer('mismatch_first_id').nullable()
      t.bigInteger('mismatch_first_seq').nullable()
      t.string('mismatch_reason', 400).nullable()
      /** The walk stopped on its time budget before the head; the next run continues. */
      t.boolean('partial').notNullable().defaultTo(false)
      /** An administrator looked at a break and accepted it (verification re-anchors here). */
      t.datetime('acknowledged_at').nullable()
      t.uuid('acknowledged_by').nullable()
      t.string('acknowledged_note', 1000).nullable()
      t.uuid('run_by').nullable()
      t.index(['last_seq'], 'ix_activity_seals_last_seq')
      t.index(['verified_at'], 'ix_activity_seals_verified_at')
    })
  }

  if (!(await knex.schema.hasTable(BRIDGES))) {
    await knex.schema.createTable(BRIDGES, (t) => {
      /** The surviving row whose predecessor was purged (no FK: the row may be purged later). */
      t.integer('activity_id').notNullable().primary()
      if (mssql) t.specificType('prev_hash', 'char(64)').notNullable()
      else t.string('prev_hash', 64).notNullable()
      t.bigInteger('prev_seq').notNullable()
      t.datetime('purged_at').notNullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(BRIDGES)
  await knex.schema.dropTableIfExists(SEALS)
  if (!(await knex.schema.hasTable(ACTIVITY))) return
  if (isMssql(knex)) {
    await knex.raw(`
      IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ux_nivaro_activity_seal_seq')
      DROP INDEX ux_nivaro_activity_seal_seq ON nivaro_activity
    `)
    await knex.raw(`
      IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nivaro_activity_unsealed')
      DROP INDEX ix_nivaro_activity_unsealed ON nivaro_activity
    `)
  }
  for (const col of ['seal_seq', 'seal_version', 'seal_hash']) {
    if (await knex.schema.hasColumn(ACTIVITY, col)) {
      await knex.schema.alterTable(ACTIVITY, (t) => {
        t.dropColumn(col)
      })
    }
  }
}
