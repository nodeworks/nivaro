/**
 * Column probe for `requested_by` / `requested_via` (migration 350, "who
 * started each push") — every insert or select that might name them must go
 * through here, never write the column names directly. A missing column
 * fails the whole INSERT/SELECT on this stack, not just the two fields.
 *
 * The probe lives in @nivaro/extension-kit (extensions used to keep a
 * hand-copied mirror of this file); this wrapper binds it to the API's
 * connection and keys it per tenant, since in cloud mode one tenant may be
 * migrated while another is not.
 */
import {
  requesterInsertFields as kitInsertFields,
  requesterSelectColumns as kitSelectColumns,
  type RequesterTable,
  resetColumnProbes
} from '@nivaro/extension-kit'
import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'

export type { RequesterTable }

const scope = () => ({ scope: getTenantId() ?? '' })

/** `{requested_by, requested_via}` for an INSERT into `table`, or `{}` before
 *  migration 350 has reached it — spread this into the insert payload. */
export function requesterInsertFields(
  table: RequesterTable,
  requestedBy: string | null | undefined,
  requestedVia: string | null | undefined
): Promise<{ requested_by?: string | null; requested_via?: string | null }> {
  return kitInsertFields(db, table, requestedBy, requestedVia, scope())
}

/** The extra column names a SELECT against `table` may safely name. */
export function requesterSelectColumns(table: RequesterTable): Promise<string[]> {
  return kitSelectColumns(db, table, scope())
}

/** Test-only: forget every probed result so the next call re-checks. */
export function resetRequesterColumnProbe(): void {
  resetColumnProbes()
}
