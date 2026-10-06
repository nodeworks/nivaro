import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { selectInChunks } from './db-batch.js'

/**
 * Per-record SLA overrides (#1239, migration 398). One record's clock in one
 * state-entry episode runs to `duration_hours` instead of its rule's duration.
 *
 * Every SLA reader goes through computeStatus / computeStatusBatch
 * (routes/sla.ts), which load the overrides for their records here in ONE
 * batched read and pick the one matching each record's current episode with
 * `pickOverride` — never a query per row. Queue caches, My Work, the
 * escalation sweep and the record banner all inherit it from there.
 */

export const SLA_OVERRIDES_TABLE = 'nivaro_sla_overrides'

export interface SlaOverrideRow {
  id: number
  collection: string
  item: string
  state_key: string
  instance_id: string
  entered_at: Date | string
  duration_hours: number
  rule_duration_hours: number | null
  reason: string
  set_by: string | null
  set_at: Date | string
  cleared_at: Date | string | null
}

/** MSSQL `datetime` rounds to 1/300s — episode identity is a tolerance window. */
export const EPISODE_TOLERANCE_MS = 1000

/** A tenant that has not run migration 398 keeps computing SLA without overrides. */
export async function slaOverridesReady(): Promise<boolean> {
  return hasColumn(SLA_OVERRIDES_TABLE, 'duration_hours').catch(() => false)
}

/**
 * The override that applies to a record right now, or null. Matches the
 * CURRENT episode only: same instance, same state key, entered within the
 * tolerance of the stored entry moment, not cleared. Newest wins.
 */
export function pickOverride(
  rows: SlaOverrideRow[] | undefined,
  episode: { instanceId: string; stateKey: string | null; enteredAt: Date }
): SlaOverrideRow | null {
  if (!rows || rows.length === 0 || !episode.stateKey) return null
  const inst = String(episode.instanceId).toUpperCase()
  const at = episode.enteredAt.getTime()
  let best: SlaOverrideRow | null = null
  for (const r of rows) {
    if (r.cleared_at) continue
    if (String(r.instance_id).toUpperCase() !== inst) continue
    if (r.state_key !== episode.stateKey) continue
    const entered = new Date(r.entered_at).getTime()
    if (!Number.isFinite(entered) || Math.abs(entered - at) >= EPISODE_TOLERANCE_MS) continue
    const hours = Number(r.duration_hours)
    if (!Number.isFinite(hours) || hours <= 0) continue
    if (!best || new Date(r.set_at).getTime() > new Date(best.set_at).getTime()) best = r
  }
  return best
}

/** Active (uncleared) overrides for many records of one collection, keyed by item. */
export async function loadActiveOverrides(
  collection: string,
  items: string[]
): Promise<Map<string, SlaOverrideRow[]>> {
  const out = new Map<string, SlaOverrideRow[]>()
  if (items.length === 0 || !(await slaOverridesReady())) return out
  const rows = (await selectInChunks(items, 2000, (chunk) =>
    db(SLA_OVERRIDES_TABLE).where({ collection }).whereIn('item', chunk).whereNull('cleared_at')
  ).catch(() => [])) as SlaOverrideRow[]
  for (const r of rows) {
    const key = String(r.item)
    const arr = out.get(key) ?? []
    arr.push(r)
    out.set(key, arr)
  }
  return out
}

/** Validate an override request body. Returns an error sentence or null. */
export function validateOverrideInput(body: {
  duration_hours?: unknown
  reason?: unknown
}): { error: string } | { hours: number; reason: string } {
  const hours = Number(body.duration_hours)
  if (!Number.isFinite(hours) || hours <= 0) {
    return { error: 'duration_hours must be a positive number of hours' }
  }
  if (hours > 24 * 365) return { error: 'duration_hours cannot exceed a year (8760 hours)' }
  const reason = String(body.reason ?? '').trim()
  if (!reason) return { error: 'A reason is required' }
  return { hours: Math.round(hours * 100) / 100, reason: reason.slice(0, 1000) }
}

/** "48h", "1.5h", "3d 4h" — the wording the activity note uses. */
export function hoursText(h: number): string {
  if (!Number.isFinite(h)) return '?'
  if (h >= 48 && h % 24 === 0) return `${h / 24}d`
  if (h >= 48) return `${Math.floor(h / 24)}d ${Math.round(h % 24)}h`
  return `${Math.round(h * 10) / 10}h`
}
