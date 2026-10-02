/**
 * Pure helpers for the investigation group "record" (chain, recording, record, write, issue):
 * which level a path step opens, the person + time a request detail carries, and small
 * formatters. No React, no fetches — tested in logic.test.ts.
 */
import type { InspectRef } from '../../registry/inspectables'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The part of a path step this file reads (shared `PathNode`). */
export interface StepLike {
  key: string
  kind: string
  at?: string
  record?: { collection: string; item: string; label?: string | null } | null
  summary?: string
}

function stepAt(node: StepLike): number | undefined {
  const t = node.at ? Date.parse(node.at) : Number.NaN
  return Number.isFinite(t) ? t : undefined
}

function recordRef(node: StepLike, at?: number): InspectRef | null {
  const r = node.record
  if (!r?.collection || r.item == null || r.item === '') return null
  return {
    kind: 'record',
    id: `${r.collection}:${r.item}`,
    at,
    label: r.label || `${r.collection} ${r.item}`
  }
}

/**
 * The investigation level a path step opens:
 *  - the chain's request (`request:<chain>`) → `request`, when the request id is known;
 *  - a write (`activity:<id>`) → `write`;
 *  - a flow run (`flow_run:<id>`) → `flow`; a partner push (`submission:<id>`) → `submission`;
 *  - a transition (`history:<id>`) → the `record` it moved;
 *  - folded groups, notifications, mail, attempts, calls → nothing (their own row says it all).
 */
export function stepRefFor(node: StepLike, requestId: string | null): InspectRef | null {
  const at = stepAt(node)
  const sep = node.key.indexOf(':')
  const prefix = sep > 0 ? node.key.slice(0, sep) : node.key
  const rest = sep > 0 ? node.key.slice(sep + 1) : ''
  switch (prefix) {
    case 'request':
      return requestId && UUID.test(requestId)
        ? { kind: 'request', id: requestId, at, label: node.summary || undefined }
        : null
    case 'activity':
      return /^\d+$/.test(rest)
        ? { kind: 'write', id: rest, at, label: `Write ${rest}` }
        : recordRef(node, at)
    case 'flow_run':
      return rest ? { kind: 'flow', id: rest, at } : null
    case 'submission':
      return /^\d+$/.test(rest) ? { kind: 'submission', id: rest, at } : null
    case 'history':
      return recordRef(node, at)
    default:
      return null
  }
}

/** What to call the drill link on a step row. */
export function stepRefLabel(ref: InspectRef): string {
  switch (ref.kind) {
    case 'request':
      return 'Request'
    case 'write':
      return 'Write'
    case 'flow':
      return 'Flow run'
    case 'submission':
      return 'Push'
    case 'record':
      return 'Record'
    default:
      return 'Inspect'
  }
}

/**
 * The person + moment a `request` detail names (Task 3's source: the api log row, maybe nested
 * under `log` / `row` / `request`). Tolerates `user` or `user_id`, `created_at` or `at`.
 */
export function requestFactsOf(detail: unknown): { user: string | null; at: number | null } {
  const pick = (o: Record<string, unknown> | null | undefined) => {
    if (!o || typeof o !== 'object') return { user: null, at: null }
    const u = o.user ?? o.user_id
    const user = typeof u === 'string' && UUID.test(u) ? u : null
    const raw = o.created_at ?? o.at ?? o.started_at
    const t = typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : Number.NaN
    return { user, at: Number.isFinite(t) && t > 0 ? t : null }
  }
  const d = (detail ?? null) as Record<string, unknown> | null
  const top = pick(d)
  if (top.user && top.at) return top
  for (const k of ['log', 'row', 'request']) {
    const inner = pick(d?.[k] as Record<string, unknown> | undefined)
    if (inner.user || inner.at) return { user: top.user ?? inner.user, at: top.at ?? inner.at }
  }
  return top
}

/** "3 min", "1 h 4 min", "12 s". */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`
}

/** "2026-10-01 14:02:31" in local time, or "—". */
export function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** `collection:id` → `{ collection, item }` (the record ref id). */
export function splitRecordRef(id: string): { collection: string; item: string } | null {
  const at = id.indexOf(':')
  if (at <= 0 || at === id.length - 1) return null
  return { collection: id.slice(0, at), item: id.slice(at + 1) }
}

/** The caller key the follow-person feature uses for a user id. */
export function followKey(userId: string): string {
  return `u${userId.toUpperCase()}`
}
