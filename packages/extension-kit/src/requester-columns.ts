import type { Knex } from 'knex'
import { hasColumn } from './column-probe.js'

/**
 * `requested_by` / `requested_via` on the ERP submission tables ("who started
 * each push", migration 350). A missing column does not just drop the two
 * fields: an INSERT or SELECT naming an unknown column fails WHOLESALE, so a
 * writer that names one anyway loses the whole submission row it was trying
 * to record. Every insert or select that might name them goes through here.
 */
export type RequesterTable = 'nivaro_erp_submissions' | 'nivaro_erp_submission_attempts'

export const REQUESTER_COLUMNS = ['requested_by', 'requested_via'] as const

/** `{requested_by, requested_via}` for an INSERT into `table` on this
 *  database, or `{}` before migration 350 has reached it — spread this into
 *  the insert payload, never write the two column names directly. */
export async function requesterInsertFields(
  db: Knex,
  table: RequesterTable | (string & {}),
  requestedBy: string | null | undefined,
  requestedVia: string | null | undefined,
  opts: { scope?: string } = {}
): Promise<{ requested_by?: string | null; requested_via?: string | null }> {
  if (!(await hasColumn(db, table, 'requested_by', opts))) return {}
  return { requested_by: requestedBy ?? null, requested_via: requestedVia ?? null }
}

/** The extra column names a SELECT against `table` may safely name —
 *  `['requested_by', 'requested_via']` once migration 350 has reached it,
 *  else `[]`. */
export async function requesterSelectColumns(
  db: Knex,
  table: RequesterTable | (string & {}),
  opts: { scope?: string } = {}
): Promise<string[]> {
  return (await hasColumn(db, table, 'requested_by', opts)) ? [...REQUESTER_COLUMNS] : []
}
