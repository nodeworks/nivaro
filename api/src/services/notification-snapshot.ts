/**
 * What they saw when notified (#1385). A notification about a record carries
 * the nivaro_revisions id current at send time; "as it was" opens that
 * snapshot beside the record as it is now and marks what moved since.
 */
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import type { NotificationTargetSpec } from './notification-target.js'

/** Housekeeping stamps every write moves — never "a change the person should see". */
export const SNAPSHOT_IGNORED_FIELDS = new Set([
  'updated_at',
  'date_updated',
  'user_updated',
  'changed',
  'modified_on'
])

const norm = (v: unknown): unknown => {
  if (v === undefined || v === '') return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
  return v
}

/**
 * The keys whose value differs between the snapshot and the current row.
 * Only keys PRESENT on the current row are judged (the current read is
 * permission-narrowed; a column the caller may not see never leaks through
 * the snapshot), minus the housekeeping stamps. A number and its string form
 * compare equal — the driver hands decimals back either way.
 */
export function changedFields(
  snapshot: Record<string, unknown>,
  current: Record<string, unknown>,
  ignore: Set<string> = SNAPSHOT_IGNORED_FIELDS
): string[] {
  const out: string[] = []
  for (const key of Object.keys(current)) {
    if (ignore.has(key) || key === 'id') continue
    const a = norm(snapshot[key])
    const b = norm(current[key])
    if (a === b) continue
    if (JSON.stringify(a) === JSON.stringify(b)) continue
    if (a !== null && b !== null && typeof a !== 'object' && typeof b !== 'object') {
      if (String(a) === String(b)) continue
      // "10.00" (a decimal stored in the snapshot's JSON) and 10 (the row now)
      // are the same figure; a boolean against 0/1 is the same bit. Only when
      // one side is a typed number/boolean — two strings ("007" → "7") did move.
      const typed = (v: unknown) => typeof v === 'number' || typeof v === 'boolean'
      if (typed(a) || typed(b)) {
        const na = Number(a)
        const nb = Number(b)
        if (
          String(a).trim() !== '' &&
          String(b).trim() !== '' &&
          Number.isFinite(na) &&
          Number.isFinite(nb) &&
          na === nb
        )
          continue
      }
    }
    out.push(key)
  }
  return out
}

export interface SnapshotRevision {
  revision_id: number
  /** The activity timestamp the revision was written at (null = unknown). */
  at: Date | string | null
  data: Record<string, unknown>
}

function parseData(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function revisionQuery() {
  return db('nivaro_revisions as r')
    .leftJoin('nivaro_activity as a', 'r.activity', 'a.id')
    .select('r.id', 'r.data', 'a.timestamp')
}

function hydrate(row: Record<string, unknown> | undefined): SnapshotRevision | null {
  if (!row) return null
  const data = parseData(row.data)
  if (!data) return null
  return {
    revision_id: Number(row.id),
    at: (row.timestamp as Date | string | null) ?? null,
    data
  }
}

/**
 * The snapshot a notification should open: the stamped revision when it still
 * exists, else the newest revision written at or before the notification's
 * own timestamp (older rows, purged revisions). Null when the record has no
 * revision from that time at all.
 */
export async function pickSnapshotRevision(opts: {
  collection: string
  item: string
  revisionId: number | null
  before: Date | string | null
}): Promise<SnapshotRevision | null> {
  if (opts.revisionId != null && Number.isFinite(Number(opts.revisionId))) {
    const row = (await revisionQuery()
      .where('r.id', Number(opts.revisionId))
      .where('r.collection', opts.collection)
      .where('r.item', String(opts.item))
      .first()) as Record<string, unknown> | undefined
    const hit = hydrate(row)
    if (hit) return hit
  }
  if (!opts.before) return null
  const before = new Date(opts.before)
  if (Number.isNaN(before.getTime())) return null
  const row = (await revisionQuery()
    .where('r.collection', opts.collection)
    .where('r.item', String(opts.item))
    .where('a.timestamp', '<=', before)
    .orderBy('r.id', 'desc')
    .first()) as Record<string, unknown> | undefined
  return hydrate(row)
}

/**
 * The newest revision id of a record — what notifyUser stamps on the row.
 * Null when the target is not a record, the column is not there yet (a tenant
 * behind migration 393), or anything fails: a stamp is a nicety, the
 * notification is not.
 */
export async function snapshotRevisionFor(
  target: NotificationTargetSpec | null
): Promise<number | null> {
  if (target?.kind !== 'record' || !target.collection || target.id == null) return null
  if (/^(nivaro|directus)_/i.test(target.collection)) return null
  try {
    if (!(await hasColumn('nivaro_notifications', 'revision_id'))) return null
    const row = (await db('nivaro_revisions')
      .where({ collection: target.collection, item: String(target.id) })
      .max({ latest: 'id' })
      .first()) as { latest?: number | string | null } | undefined
    const id = Number(row?.latest)
    return Number.isFinite(id) && id > 0 ? id : null
  } catch {
    return null
  }
}
