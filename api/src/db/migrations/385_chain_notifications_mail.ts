import type { Knex } from 'knex'
import { runLongSql } from '../../services/run-long.js'
import { isMssql } from '../dialect.js'

/**
 * Chain stamps on notifications + the mail log (#706) and on job runs (#707).
 *
 * - nivaro_notifications, nivaro_mail_log: chain_id + chain_parent (the same
 *   pair migration 351 put on the seven central write tables), so an event's
 *   path ends with who was told and by which channel.
 * - nivaro_job_runs: chain_id only — the chain a cron tick started, so the
 *   Background Jobs console can open "what it wrote" for one run. A run is
 *   the ROOT of its chain (`cron:<job>`), never a step, so it needs no parent.
 *
 * Every column is nullable, so adding it is metadata-only on SQL Server. The
 * chain_id indexes are FILTERED (chain_id IS NOT NULL): every existing row is
 * NULL, so the build sorts nothing — but nivaro_notifications can be large,
 * so on SQL Server each index is built on its own long request (migration
 * 334 / 351's pattern), outside knex's batch transaction. Writers probe the
 * columns per tenant (chainFields / hasColumn), so a database behind this
 * migration keeps writing.
 */
export const config = { transaction: false }

const PG_CLIENTS = new Set(['pg', 'postgres', 'postgresql'])

function clientOf(knex: Knex): string {
  // biome-ignore lint/suspicious/noExplicitAny: knex client config is untyped here
  return String((knex as any).client?.config?.client ?? '')
}

/** The chain_id index, per dialect. Idempotent on every branch. */
async function createChainIndex(knex: Knex, table: string, ix: string): Promise<void> {
  if (isMssql(knex)) {
    await runLongSql(
      `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${ix}')
         CREATE INDEX ${ix} ON ${table} (chain_id) WHERE chain_id IS NOT NULL`,
      { knex, timeoutMs: 60 * 60 * 1000 }
    )
    return
  }
  if (PG_CLIENTS.has(clientOf(knex))) {
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
  if (isMssql(knex)) {
    await knex.raw(
      `IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${ix}') DROP INDEX ${ix} ON ${table}`
    )
    return
  }
  if (PG_CLIENTS.has(clientOf(knex))) {
    await knex.raw(`DROP INDEX IF EXISTS ${ix}`)
    return
  }
  await knex.schema
    .alterTable(table, (t) => {
      t.dropIndex(['chain_id'], ix)
    })
    .catch(() => undefined)
}

/** Tables that carry the full chain pair (id + open step). */
const STEP_TABLES = ['nivaro_notifications', 'nivaro_mail_log'] as const
/** Tables that only record which chain they started. */
const ROOT_TABLES = ['nivaro_job_runs'] as const

export async function up(knex: Knex): Promise<void> {
  for (const table of [...STEP_TABLES, ...ROOT_TABLES]) {
    if (!(await knex.schema.hasTable(table))) continue
    if (!(await knex.schema.hasColumn(table, 'chain_id'))) {
      await knex.schema.alterTable(table, (t) => {
        t.uuid('chain_id').nullable()
      })
    }
    if (
      (STEP_TABLES as readonly string[]).includes(table) &&
      !(await knex.schema.hasColumn(table, 'chain_parent'))
    ) {
      await knex.schema.alterTable(table, (t) => {
        t.string('chain_parent', 120).nullable()
      })
    }
    await createChainIndex(knex, table, `ix_${table}_chain_id`)
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const table of [...STEP_TABLES, ...ROOT_TABLES]) {
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
