/**
 * "Does this column exist yet?" — asked by writers that must keep working on a
 * database that has not run the migration adding it (a cloud tenant, an image
 * ahead of its ledger). The probe itself lives in @nivaro/extension-kit so
 * extensions share it; this wrapper binds it to the API's own connection and
 * keys it per tenant.
 */
import { hasColumn as probeColumn, resetColumnProbes } from '@nivaro/extension-kit'
import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'

export async function hasColumn(table: string, column: string): Promise<boolean> {
  return probeColumn(db, table, column, { scope: getTenantId() ?? '' })
}

export { resetColumnProbes }
