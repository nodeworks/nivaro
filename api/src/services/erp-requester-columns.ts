/**
 * Column probe for `requested_by` / `requested_via` (migration 350, "who
 * started each push") — every insert or select that might name them must go
 * through here, never write the column names directly.
 *
 * A missing column doesn't just drop the two fields: on this stack an
 * `INSERT`/`SELECT` naming an unknown column fails WHOLESALE, so a writer
 * that names one anyway loses the entire row it was trying to record — the
 * submission itself, or its attempt-history entry — not just the requester.
 * `nivaro_erp_submissions` and `nivaro_erp_submission_attempts` both gain
 * the columns in the SAME migration (350_erp_submission_requested_by.ts),
 * so one probe per table (on `requested_by`) stands in for both.
 *
 * Precedent: `originFields` / `originColumn` (note-authorship.ts,
 * activity.ts) probe once per process for migration 340's `origin` column.
 * This differs in ONE way: a MISS is remembered for only a minute, not
 * forever. The columns can land on a running process mid-session — exactly
 * what happened while this feature shipped, when a teammate's dev API
 * restarted and ran migration 350 out from under code that assumed it was
 * already there — so a database that catches up should be picked up
 * without a restart. A HIT is permanent: a column, once added, is never
 * dropped from under a running process.
 *
 * Probes are kept PER TENANT (cloud mode: `db` is a per-request tenant
 * proxy, and one tenant may be migrated while another is not yet) — one
 * key per tenant id, a single key when self-hosted.
 */
import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'

export type RequesterTable = 'nivaro_erp_submissions' | 'nivaro_erp_submission_attempts'

const MISS_TTL_MS = 60_000

interface ProbeState {
  hit: boolean
  at: number
  inflight: Promise<boolean> | null
}

const probes = new Map<string, ProbeState>()

async function probe(table: RequesterTable): Promise<boolean> {
  const key = `${getTenantId() ?? ''}\u0000${table}`
  const p = probes.get(key)
  if (p?.hit) return true
  if (p?.inflight) return p.inflight
  if (p && Date.now() - p.at < MISS_TTL_MS) return false
  const inflight = (async () => {
    try {
      return await db.schema.hasColumn(table, 'requested_by')
    } catch {
      return false
    }
  })()
  probes.set(key, { hit: false, at: p?.at ?? 0, inflight })
  const hit = await inflight
  probes.set(key, { hit, at: Date.now(), inflight: null })
  return hit
}

/**
 * `{requested_by, requested_via}` for an INSERT into `table`, or `{}` before
 * migration 350 has reached it — spread this into the insert payload,
 * never write the two column names directly.
 */
export async function requesterInsertFields(
  table: RequesterTable,
  requestedBy: string | null | undefined,
  requestedVia: string | null | undefined
): Promise<{ requested_by?: string | null; requested_via?: string | null }> {
  if (!(await probe(table))) return {}
  return { requested_by: requestedBy ?? null, requested_via: requestedVia ?? null }
}

/**
 * The extra column names a SELECT against `table` may safely name —
 * `['requested_by', 'requested_via']` once migration 350 has reached it,
 * else `[]`. A `.first(...cols)` naming a missing column fails the whole
 * read, same as an insert.
 */
export async function requesterSelectColumns(table: RequesterTable): Promise<string[]> {
  return (await probe(table)) ? ['requested_by', 'requested_via'] : []
}

/** Test-only: forget every probed result so the next call re-checks. */
export function resetRequesterColumnProbe(): void {
  probes.clear()
}
