import type { Knex } from 'knex'
import { runLongSql } from '../../services/run-long.js'

/**
 * Integration event chains (spec 2026-09-24-integration-event-paths).
 *
 * chain_id + chain_parent on the seven central write tables, so an event's
 * whole path (writes → transitions → flows → pushes → partner replies) reads
 * back by one indexed seek per table. nivaro_chain_roots maps event rows that
 * live in tables we must not alter (extension feeds like mdsi_logs) to their
 * chain.
 *
 * Adding a nullable column is metadata-only on SQL Server. The indexes are
 * FILTERED (chain_id IS NOT NULL): every existing row is NULL, so the build
 * is a scan with nothing to sort — still minutes on nivaro_activity (11M) /
 * nivaro_revisions-sized tables, so each is built on its own long request
 * (migration 334's pattern), outside knex's batch transaction.
 */
export const config = { transaction: false }

function dialectOf(knex: Knex): string {
  // biome-ignore lint/suspicious/noExplicitAny: knex client config is untyped here
  return String((knex as any).client?.config?.client ?? '')
}

const PG_CLIENTS = new Set(['pg', 'postgres', 'postgresql'])

/**
 * The chain_id index, per dialect. SQL Server builds a FILTERED index on its
 * own long request, on THIS migration's connection (`knex` — not the app's
 * global handle, which a cloud tenant migrated through /admin/migrate does not
 * share). Postgres gets the same partial index; any other dialect a plain one.
 * Every branch is idempotent.
 */
async function createChainIndex(knex: Knex, table: string, ix: string): Promise<void> {
  const client = dialectOf(knex)
  if (client === 'mssql') {
    await runLongSql(
      `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${ix}')
         CREATE INDEX ${ix} ON ${table} (chain_id) WHERE chain_id IS NOT NULL`,
      { knex, timeoutMs: 60 * 60 * 1000 }
    )
    return
  }
  if (PG_CLIENTS.has(client)) {
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS ${ix} ON ${table} (chain_id) WHERE chain_id IS NOT NULL`
    )
    return
  }
  try {
    await knex.schema.alterTable(table, (t) => {
      t.index(['chain_id'], ix)
    })
  } catch (err) {
    // Already there from an earlier run — the only failure worth tolerating.
    if (!/exist|duplicate/i.test(String((err as Error)?.message ?? err))) throw err
  }
}

async function dropChainIndex(knex: Knex, table: string, ix: string): Promise<void> {
  const client = dialectOf(knex)
  if (client === 'mssql') {
    await knex.raw(
      `IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${ix}') DROP INDEX ${ix} ON ${table}`
    )
    return
  }
  if (PG_CLIENTS.has(client)) {
    await knex.raw(`DROP INDEX IF EXISTS ${ix}`)
    return
  }
  await knex.schema
    .alterTable(table, (t) => {
      t.dropIndex(['chain_id'], ix)
    })
    .catch(() => undefined)
}

const TABLES = [
  'nivaro_activity',
  'nivaro_api_logs',
  'nivaro_erp_submissions',
  'nivaro_erp_submission_attempts',
  'nivaro_external_api_logs',
  'nivaro_workflow_history',
  'nivaro_flow_runs'
] as const

export async function up(knex: Knex): Promise<void> {
  for (const table of TABLES) {
    if (!(await knex.schema.hasTable(table))) continue
    if (!(await knex.schema.hasColumn(table, 'chain_id'))) {
      await knex.schema.alterTable(table, (t) => {
        t.uuid('chain_id').nullable()
      })
    }
    if (!(await knex.schema.hasColumn(table, 'chain_parent'))) {
      await knex.schema.alterTable(table, (t) => {
        t.string('chain_parent', 120).nullable()
      })
    }
    await createChainIndex(knex, table, `ix_${table}_chain_id`)
  }

  if (!(await knex.schema.hasTable('nivaro_chain_roots'))) {
    await knex.schema.createTable('nivaro_chain_roots', (t) => {
      t.bigIncrements('id').primary()
      t.uuid('chain_id').notNullable()
      t.string('source', 120).notNullable()
      t.string('ref', 300).notNullable()
      t.uuid('replay_of').nullable()
      t.datetime('created_at').notNullable()
      t.index(['source', 'ref'], 'ix_nivaro_chain_roots_source_ref')
      t.index(['chain_id'], 'ix_nivaro_chain_roots_chain_id')
      t.index(['replay_of'], 'ix_nivaro_chain_roots_replay_of')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_chain_roots')) {
    await knex.schema.dropTable('nivaro_chain_roots')
  }
  for (const table of TABLES) {
    if (!(await knex.schema.hasTable(table))) continue
    await dropChainIndex(knex, table, `ix_${table}_chain_id`)
    for (const col of ['chain_id', 'chain_parent']) {
      if (await knex.schema.hasColumn(table, col)) {
        await knex.schema.alterTable(table, (t) => {
          t.dropColumn(col)
        })
      }
    }
  }
}
