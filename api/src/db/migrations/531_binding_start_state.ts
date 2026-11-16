import type { Knex } from 'knex'

/**
 * Migration 531 — create a record in a chosen pipeline step (2026-11-16).
 *
 * `nivaro_workflow_bindings` gains who may create a record of the bound
 * collection straight into a later step (`$start_state` on REST,
 * `start_state` on GraphQL — services/start-state.ts):
 *   start_state_roles    nvarchar(max) JSON array of role ids; null/[] = administrators only
 *   start_state_allowed  nvarchar(max) JSON array of state KEYS those roles may pick; null/[] = any
 *
 * Config columns on a config table: config promotion copies them with the
 * binding row. Readers probe the columns, so an unmigrated tenant answers
 * "administrators only". Additive and guarded.
 */
const TABLE = 'nivaro_workflow_bindings'
const COLUMNS = ['start_state_roles', 'start_state_allowed'] as const

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  for (const col of COLUMNS) {
    if (!(await knex.schema.hasColumn(TABLE, col))) {
      await knex.schema.alterTable(TABLE, (t) => {
        t.text(col).nullable()
      })
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  for (const col of COLUMNS) {
    if (await knex.schema.hasColumn(TABLE, col)) {
      await knex.schema.alterTable(TABLE, (t) => {
        t.dropColumn(col)
      })
    }
  }
}
