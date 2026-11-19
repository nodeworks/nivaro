import type { Knex } from 'knex'
import { runLongSql } from '../../services/run-long.js'
import { isMssql, utcNow } from '../dialect.js'

/**
 * What an Ask AI plan wrote, kept so it can be undone (Rob 2026-11-18: "for admins
 * this AI should not be a restriction … just log it and make it reversible what they
 * delete / change / create").
 *
 *   nivaro_ai_undo_records — one row per record a plan step wrote:
 *     plan_id, step_id   the plan (nivaro_ai_proposals.id, action_type 'plan') + step
 *     collection, item   the record
 *     op                 update | create | delete
 *     before             JSON: update = the changed fields' values before the write;
 *                        delete / create = NULL (a deleted record is restored from the
 *                        trash row the items service wrote — no copy is kept here)
 *     after              JSON: the values the step wrote (update / create)
 *     rev                newest nivaro_revisions id just after the write (the witness
 *                        that nothing touched the record since)
 *     undo_status        NULL = not undone; undone | skipped | failed | redacted (values
 *                        removed by a person redaction — the record cannot be put back)
 *     undo_note          why a record was skipped or failed
 *     undone_at, created_at
 *
 * Before 537 a step kept at most 500 such records inside the plan's JSON. A plan of
 * 62,000 records cannot, so every step now writes here (services/ai-undo-store.ts),
 * and a step on a database behind 537 refuses to run more records than it can undo.
 * Rows are pruned 30 days after they were written, or sooner on a collection whose own
 * trash window is shorter (cron ai-undo-prune) — never longer than that collection keeps
 * its deleted records. A person redaction scrubs the values that name them.
 *
 * New table only (production is a replication publisher: nothing altered). No FKs:
 * a plan row may be pruned or a collection dropped without blocking either. The
 * read index (plan, step, id) pages a step in write order; created_at feeds the prune.
 * Not promoted between environments (efp-ops promote SKIP).
 */
export const config = { transaction: false }

const TABLE = 'nivaro_ai_undo_records'

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.schema.createTable(TABLE, (t) => {
      t.bigIncrements('id').primary()
      t.string('plan_id', 36).notNullable()
      t.string('step_id', 36).notNullable()
      t.string('collection', 64).notNullable()
      t.string('item', 64).notNullable()
      t.string('op', 10).notNullable()
      t.text('before').nullable()
      t.text('after').nullable()
      t.bigInteger('rev').nullable()
      t.string('undo_status', 12).nullable()
      t.string('undo_note', 300).nullable()
      t.datetime('undone_at', { precision: 3 }).nullable()
      t.datetime('created_at', { precision: 3 }).notNullable().defaultTo(utcNow(knex))
    })
  }
  const indexes: Array<[string, string]> = [
    ['ix_nivaro_ai_undo_records_plan', '([plan_id], [step_id], [id])'],
    ['ix_nivaro_ai_undo_records_created', '([created_at])']
  ]
  for (const [name, cols] of indexes) {
    if (isMssql(knex)) {
      await runLongSql(
        `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${name}' AND object_id = OBJECT_ID('${TABLE}'))
           CREATE INDEX ${name} ON ${TABLE} ${cols}`,
        { knex, timeoutMs: 10 * 60 * 1000 }
      )
      continue
    }
    try {
      await knex.schema.alterTable(TABLE, (t) => {
        t.index(
          cols
            .replace(/[()[\]\s]/g, '')
            .split(',')
            .filter(Boolean),
          name
        )
      })
    } catch {
      // Already there (a re-run) — a speed-up only.
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) await knex.schema.dropTable(TABLE)
}
