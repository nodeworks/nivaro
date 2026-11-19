import type { Knex } from 'knex'
import { runLongSql } from '../../services/run-long.js'
import { isMssql } from '../dialect.js'

/**
 * AI call log, readable (Rob 2026-11-18: "filter, sort, search … see the
 * actual message not just the json … click to see the full chat thread").
 *
 *   nivaro_ai_calls.question         nvarchar(500) NULL — the person's latest
 *                                    question this call answered (searchable
 *                                    without reading the 48 KB request body);
 *                                    '' = the call carried no question
 *   nivaro_ai_calls.tools            nvarchar(400) NULL — `,a,b,` the tool
 *                                    names the model called in this response
 *                                    (wrapped in commas so `LIKE '%,name,%'`
 *                                    matches a whole name)
 *   nivaro_ai_calls.conversation_id  nvarchar(36) NULL — the Ask AI
 *                                    conversation the request belonged to, when
 *                                    it had one (indexed: thread view, filter)
 *
 * Old rows get question/tools from a background backfill (services/ai-call-log/
 * backfill.ts); their conversation is found through the owner's threads. Every
 * writer and reader probes the columns (services/ai-call-log/columns.ts), so a
 * database behind 539 keeps logging. ADD COLUMN nullable only (production is a
 * replication publisher); the index is built on its own long request outside
 * knex's batch transaction (migration 535's pattern). Guarded both ways.
 */
export const config = { transaction: false }

const TABLE = 'nivaro_ai_calls'
const INDEX = 'ix_ai_calls_conversation'

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (!(await knex.schema.hasColumn(TABLE, 'question'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.string('question', 500).nullable()
    })
  }
  if (!(await knex.schema.hasColumn(TABLE, 'tools'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.string('tools', 400).nullable()
    })
  }
  if (!(await knex.schema.hasColumn(TABLE, 'conversation_id'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.string('conversation_id', 36).nullable()
    })
  }
  if (isMssql(knex)) {
    await runLongSql(
      `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${INDEX}' AND object_id = OBJECT_ID('${TABLE}'))
         CREATE INDEX ${INDEX} ON ${TABLE} ([conversation_id]) INCLUDE ([request_id], [created_at]) WHERE [conversation_id] IS NOT NULL`,
      { knex, timeoutMs: 60 * 60 * 1000 }
    )
    return
  }
  try {
    await knex.schema.alterTable(TABLE, (t) => {
      t.index(['conversation_id'], INDEX)
    })
  } catch {
    // Already there (a re-run) — the index is a speed-up only.
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (isMssql(knex)) {
    await knex.raw(
      `IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${INDEX}' AND object_id = OBJECT_ID('${TABLE}')) DROP INDEX ${INDEX} ON ${TABLE}`
    )
  } else {
    try {
      await knex.schema.alterTable(TABLE, (t) => {
        t.dropIndex(['conversation_id'], INDEX)
      })
    } catch {
      // not there
    }
  }
  for (const col of ['question', 'tools', 'conversation_id']) {
    if (await knex.schema.hasColumn(TABLE, col)) {
      await knex.schema.alterTable(TABLE, (t) => {
        t.dropColumn(col)
      })
    }
  }
}
