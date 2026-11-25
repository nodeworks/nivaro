import type { Knex } from 'knex'
import { db } from '../../../db/index.js'

/**
 * nivaro_hub_ops_health (migration 568): one row per (scope, ref_id) — scope `driver` (a Docker
 * driver's volume storage) or `environment` (an app environment's files usage + its last issue
 * read). Written only by the Hub's ops collector and the "check now" routes.
 */

export const OPS_HEALTH = 'nivaro_hub_ops_health'

export type OpsScope = 'driver' | 'environment'

export interface OpsHealthRow {
  scope: OpsScope
  ref_id: number
  state: string
  level: string
  kind: string | null
  total_bytes: number | null
  free_bytes: number | null
  used_bytes: number | null
  files: number | null
  files_complete: boolean | null
  prev_used_bytes: number | null
  prev_checked_at: string | null
  issues_state: string | null
  issues_at: string | null
  issues_truncated: boolean | null
  notified_level: string | null
  notified_at: string | null
  error: string | null
  checked_at: string | null
}

const n = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const x = Number(v)
  return Number.isFinite(x) ? x : null
}
const b = (v: unknown): boolean | null =>
  v == null ? null : v === true || v === 1 || v === '1' || v === 'true'
const iso = (v: unknown): string | null => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export function opsHealthFromRow(r: Record<string, unknown>): OpsHealthRow {
  return {
    scope: String(r.scope) as OpsScope,
    ref_id: Number(r.ref_id),
    state: String(r.state ?? 'unknown'),
    level: String(r.level ?? 'unknown'),
    kind: (r.kind as string | null) ?? null,
    total_bytes: n(r.total_bytes),
    free_bytes: n(r.free_bytes),
    used_bytes: n(r.used_bytes),
    files: n(r.files),
    files_complete: b(r.files_complete),
    prev_used_bytes: n(r.prev_used_bytes),
    prev_checked_at: iso(r.prev_checked_at),
    issues_state: (r.issues_state as string | null) ?? null,
    issues_at: iso(r.issues_at),
    issues_truncated: b(r.issues_truncated),
    notified_level: (r.notified_level as string | null) ?? null,
    notified_at: iso(r.notified_at),
    error: (r.error as string | null) ?? null,
    checked_at: iso(r.checked_at)
  }
}

export async function readOpsHealth(
  scope: OpsScope,
  refIds?: number[],
  k: Knex = db
): Promise<OpsHealthRow[]> {
  const q = k(OPS_HEALTH).where({ scope })
  if (refIds) {
    if (!refIds.length) return []
    q.whereIn('ref_id', refIds)
  }
  return ((await q.select('*')) as Array<Record<string, unknown>>).map(opsHealthFromRow)
}

/** Update the (scope, ref_id) row, or insert it (a lost insert race becomes the update). */
export async function writeOpsHealth(
  scope: OpsScope,
  refId: number,
  fields: Record<string, unknown>,
  k: Knex = db
): Promise<void> {
  const changed = await k(OPS_HEALTH).where({ scope, ref_id: refId }).update(fields)
  if (Number(changed) > 0) return
  try {
    await k(OPS_HEALTH).insert({ scope, ref_id: refId, ...fields })
  } catch {
    await k(OPS_HEALTH).where({ scope, ref_id: refId }).update(fields)
  }
}
