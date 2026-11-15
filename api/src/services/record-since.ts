import { db } from '../db/index.js'
import type { User } from '../types.js'
import { getAllowedFields } from './permissions.js'

/**
 * "Since this email" (realtime round 3, item 2).
 *
 * Record links in emails carry the send time (`?since=<iso>`, services/mail-since-links.ts). The
 * record form opened from one asks what happened to the record after that moment and shows one
 * quiet line: "Since this email: moved to Approved · 2 fields changed".
 *
 * Judged AS THE VIEWER: the caller must be able to read the record (the route checks that), and
 * a field change counts only when it touched a field the viewer may read; a field comment counts
 * only on a readable field. Everyone's changes count — the email described the record as it was
 * when it was sent, so the viewer's own later action is part of "what changed since".
 */

export interface SinceSummary {
  since: string
  /** The step the record last moved to after `since` (null = no move). */
  moved_to: { label: string; color: string | null } | null
  transitions: number
  field_changes: number
  /** Human labels of the changed fields the viewer may read (first 8). */
  fields: string[]
  comments: number
}

function parseDelta(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null
  if (typeof raw === 'object') return raw as Record<string, unknown>
  try {
    const v = JSON.parse(String(raw))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

/**
 * Pure assembly — exported for tests. `allowed` = the viewer's readable fields, null = all.
 * `transitions` are oldest first.
 */
export function summarizeSince(input: {
  since: Date
  deltas: unknown[]
  allowed: string[] | null
  transitions: Array<{ label: string | null; color?: string | null }>
  comments: Array<{ field?: string | null }>
  labels?: Map<string, string | null>
}): SinceSummary | null {
  const canRead = (f: string) => input.allowed == null || input.allowed.includes(f)
  const fields = new Set<string>()
  for (const raw of input.deltas) {
    const delta = parseDelta(raw)
    if (!delta) continue
    for (const k of Object.keys(delta)) if (canRead(k)) fields.add(k)
  }
  const comments = input.comments.filter((c) => c.field == null || canRead(String(c.field))).length
  const last = input.transitions[input.transitions.length - 1]
  const moved_to = last
    ? { label: String(last.label ?? 'a new step'), color: last.color ?? null }
    : null
  if (fields.size === 0 && comments === 0 && !moved_to) return null
  const names = [...fields].slice(0, 8)
  return {
    since: input.since.toISOString(),
    moved_to,
    transitions: input.transitions.length,
    field_changes: fields.size,
    fields: names.map(
      (f) => input.labels?.get(f) || f.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    ),
    comments
  }
}

/** A `since` value from a link: a real past moment within a year, else null. */
export function parseSinceParam(raw: unknown, now = Date.now()): Date | null {
  if (typeof raw !== 'string' || raw.length > 40) return null
  const t = Date.parse(raw)
  if (!Number.isFinite(t)) return null
  if (t > now + 5 * 60_000) return null
  if (t < now - 366 * 24 * 3600_000) return null
  return new Date(t)
}

/** What changed on one record after `since`, as `user` may see it. The caller checked the record. */
export async function recordChangesSince(
  user: User,
  isAdmin: boolean,
  collection: string,
  id: string,
  since: Date
): Promise<SinceSummary | null> {
  let allowed: string[] | null = null
  if (!isAdmin) {
    const list = await getAllowedFields(user, 'read', collection)
    allowed = list == null || list.includes('*') ? null : list
  }
  const [deltas, transitions, comments] = await Promise.all([
    db('nivaro_activity as a')
      .join('nivaro_revisions as r', 'r.activity', 'a.id')
      .where({ 'a.collection': collection, 'a.item': id })
      .whereIn('a.action', ['create', 'update'])
      .where('a.timestamp', '>', since)
      .limit(500)
      .pluck('r.delta') as Promise<unknown[]>,
    db('nivaro_workflow_history as h')
      .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
      .leftJoin('nivaro_workflow_states as s', 's.id', 'h.to_state')
      .where({ 'i.collection': collection, 'i.item': id })
      .where('h.timestamp', '>', since)
      .orderBy('h.timestamp', 'asc')
      .orderBy('h.id', 'asc')
      .limit(200)
      .select('s.label', 's.color') as Promise<
      Array<{ label: string | null; color: string | null }>
    >,
    db('nivaro_comments')
      .where({ collection, item: id })
      .whereNull('deleted_at')
      .where('created_at', '>', since)
      .limit(500)
      .select('field')
      .catch(() =>
        // Before field comments (migration 521) every comment is a record comment.
        db('nivaro_comments')
          .where({ collection, item: id })
          .whereNull('deleted_at')
          .where('created_at', '>', since)
          .limit(500)
          .select(db.raw('NULL as field'))
      ) as Promise<Array<{ field: string | null }>>
  ])
  const draft = summarizeSince({ since, deltas, allowed, transitions, comments })
  if (!draft || draft.field_changes === 0) return draft
  // Human labels for the readable fields that changed (best effort).
  const machine = new Set<string>()
  for (const raw of deltas) {
    const d = parseDelta(raw)
    if (d)
      for (const k of Object.keys(d)) if (allowed == null || allowed.includes(k)) machine.add(k)
  }
  const rows = (await db('nivaro_fields')
    .where('collection', collection)
    .whereIn('field', [...machine].slice(0, 8))
    .select('field', 'label')
    .catch(() => [])) as Array<{ field: string; label: string | null }>
  return summarizeSince({
    since,
    deltas,
    allowed,
    transitions,
    comments,
    labels: new Map(rows.map((r) => [r.field, r.label]))
  })
}
