// api/src/services/traffic-inspect/record-logic.ts
/**
 * Pure helpers behind the Traffic Map drill-down group "record" (chain, recording, record,
 * write, issue). No database, no request — everything here is unit-tested in
 * record-logic.test.ts; services/traffic-inspect/record.ts does the reads.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const INT_RE = /^[1-9][0-9]{0,17}$/
export const COLLECTION_RE = /^[A-Za-z0-9_]{1,128}$/
/** A record's own id: digits, a uuid, or a short slug-like key. Never SQL-meaningful. */
export const ITEM_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/

/** Error clips within this many ms of the moment count as "what they saw". */
export const CLIP_SLACK_MS = 2 * 60_000
/** Recordings are purged after 7 days (daily retention pass). */
export const RECORDING_RETENTION_MS = 7 * 86_400_000
/** API logs are kept 14 days. */
export const API_LOG_RETENTION_MS = 14 * 86_400_000

/** `collection:id` → its two halves, or null when either half is not a safe identifier. */
export function parseRecordId(raw: string): { collection: string; item: string } | null {
  const at = raw.indexOf(':')
  if (at <= 0) return null
  const collection = raw.slice(0, at)
  const item = raw.slice(at + 1)
  if (!COLLECTION_RE.test(collection) || !ITEM_ID_RE.test(item)) return null
  return { collection, item }
}

/** A recording ref id: a recording uuid, or `for:<user uuid>` (resolve by person + time). */
export function parseRecordingId(
  raw: string
): { kind: 'recording'; id: string } | { kind: 'for'; user: string } | null {
  if (UUID_RE.test(raw)) return { kind: 'recording', id: raw }
  if (raw.startsWith('for:') && UUID_RE.test(raw.slice(4)))
    return { kind: 'for', user: raw.slice(4) }
  return null
}

/** An issue ref id: the issue's int id, or `rid:<request uuid>` (the issue a request raised). */
export function parseIssueId(
  raw: string
): { kind: 'issue'; id: number } | { kind: 'rid'; rid: string } | null {
  if (INT_RE.test(raw)) return { kind: 'issue', id: Number(raw) }
  if (raw.startsWith('rid:') && UUID_RE.test(raw.slice(4)))
    return { kind: 'rid', rid: raw.slice(4) }
  return null
}

export function toMs(v: unknown): number | null {
  if (v == null || v === '') return null
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v))
  return Number.isFinite(t) ? t : null
}

export interface RecordingRow {
  id: string
  user?: string | null
  app?: string | null
  started_at: unknown
  ended_at?: unknown
  last_event_at?: unknown
  event_count?: number | null
}

export type RecordingPick =
  | { found: true; id: string; offset_ms: number; clip: boolean; distance_ms: number }
  | { found: false; reason: string }

/** The last moment a recording holds: its newest event, else its end, else its start. */
export function recordingEnd(r: RecordingRow): number | null {
  return toMs(r.last_event_at) ?? toMs(r.ended_at) ?? toMs(r.started_at)
}

/**
 * Which recording shows what a person saw at `at`:
 *  1. a full recording covering the moment (started_at ≤ at ≤ last event) — when several tabs
 *     were recording, the one whose span is shortest around it (the tab most likely in front),
 *     ties to the newest start;
 *  2. else the nearest error clip (app 'error-clip') within ±2 min;
 *  3. else none, with the reason in plain words.
 */
export function pickRecordingFor(
  rows: RecordingRow[],
  at: number,
  opts: { now: number; recordingOn: boolean; clipsOn: boolean }
): RecordingPick {
  const full = rows.filter((r) => r.app !== 'error-clip')
  const clips = rows.filter((r) => r.app === 'error-clip')
  let best: { r: RecordingRow; span: number; start: number } | null = null
  for (const r of full) {
    const start = toMs(r.started_at)
    const end = recordingEnd(r)
    if (start == null || end == null) continue
    if (start > at || end < at) continue
    const span = end - start
    if (!best || span < best.span || (span === best.span && start > best.start))
      best = { r, span, start }
  }
  if (best)
    return {
      found: true,
      id: String(best.r.id),
      offset_ms: Math.max(0, at - best.start),
      clip: false,
      distance_ms: 0
    }
  let clip: { r: RecordingRow; dist: number; start: number } | null = null
  for (const r of clips) {
    const start = toMs(r.started_at)
    const end = recordingEnd(r) ?? start
    if (start == null || end == null) continue
    const dist = at < start ? start - at : at > end ? at - end : 0
    if (dist > CLIP_SLACK_MS) continue
    if (!clip || dist < clip.dist) clip = { r, dist, start }
  }
  if (clip)
    return {
      found: true,
      id: String(clip.r.id),
      offset_ms: Math.max(0, at - clip.start),
      clip: true,
      distance_ms: clip.dist
    }
  if (opts.now - at > RECORDING_RETENTION_MS)
    return {
      found: false,
      reason: 'Recordings are kept for 7 days; this moment is older than that.'
    }
  if (!opts.recordingOn && !opts.clipsOn)
    return {
      found: false,
      reason:
        'Session recording is off, and so are error clips — nothing was being recorded. Turn recording on under Session replays.'
    }
  if (!opts.recordingOn)
    return {
      found: false,
      reason:
        'Full session recording is off and no error clip was saved around this moment. Turn recording on under Session replays.'
    }
  return { found: false, reason: 'No recording of this person covers that moment.' }
}

/** Parse a JSON text column; null when absent or unreadable. */
export function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (raw == null || raw === '') return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  try {
    const v = JSON.parse(String(raw))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * What a write changed, ready for field labelling: `delta` holds the NEW values (a revision
 * stores only those), `previous` the snapshot before it (old values).
 *  - update: the revision's delta against the previous revision's snapshot;
 *  - create: every field of the created snapshot is new (no previous);
 *  - delete: every field the record last held goes to nothing.
 * `note` says plainly when nothing could be shown and why.
 */
export function shapeWriteDelta(input: {
  action: string
  delta: unknown
  data: unknown
  prevData: unknown
  hasRevision: boolean
}): {
  delta: Record<string, unknown> | null
  previous: Record<string, unknown> | null
  note: string | null
} {
  const action = String(input.action)
  if (!input.hasRevision) {
    return {
      delta: null,
      previous: null,
      note: 'No revision was kept for this write — the collection logs activity only, not field values.'
    }
  }
  const delta = parseJsonObject(input.delta)
  const data = parseJsonObject(input.data)
  const prev = parseJsonObject(input.prevData)
  if (action === 'create') {
    const created = data ?? delta
    if (!created) return { delta: null, previous: null, note: 'The created values were not kept.' }
    return { delta: created, previous: null, note: null }
  }
  if (action === 'delete') {
    const last = prev ?? data
    if (!last) return { delta: null, previous: null, note: 'What the record held was not kept.' }
    const gone: Record<string, unknown> = {}
    for (const k of Object.keys(last)) gone[k] = null
    return { delta: gone, previous: last, note: null }
  }
  if (!delta || Object.keys(delta).length === 0)
    return { delta: null, previous: prev, note: 'This update changed no field values.' }
  return {
    delta,
    previous: prev,
    note: prev ? null : 'The earlier version was not kept, so old values are unknown.'
  }
}

/**
 * Does an issue title (`[server] METHOD /route/:param: message`) name this request? The
 * route template's `:params` match any one path segment; the query string is ignored.
 */
export function issueTitleMatchesRequest(title: string, method: string, path: string): boolean {
  const m = /^\[server\]\s+([A-Z]+)\s+(\S+?):\s/.exec(title)
  if (!m) return false
  if (m[1] !== method.toUpperCase()) return false
  const template = m[2]
  const cleanPath = path.split('?')[0]
  const tSegs = template.split('/')
  const pSegs = cleanPath.split('/')
  if (tSegs.length !== pSegs.length) {
    // A trailing wildcard (`*`) template swallows the rest.
    if (!(tSegs[tSegs.length - 1] === '*' && pSegs.length >= tSegs.length - 1)) return false
  }
  for (let i = 0; i < tSegs.length; i++) {
    const t = tSegs[i]
    if (t === '*') return true
    const p = pSegs[i]
    if (p === undefined) return false
    if (t.startsWith(':')) {
      if (p === '') return false
      continue
    }
    if (t !== p) return false
  }
  return true
}

/** The newest-first touch list a record panel shows, or the latest ones when the window is empty. */
export function touchesNote(inWindow: number, windowSec: number, total: number): string | null {
  if (inWindow > 0) return null
  if (total === 0) return 'Nobody has written to this record that Nivaro recorded.'
  const mins = Math.round(windowSec / 60)
  return `No writes within ${mins >= 1 ? `${mins} min` : `${windowSec} s`} of this moment — showing the latest ones instead.`
}

/** The parts of a nivaro_issues `details` text: route, request context, stack. */
export function splitIssueDetails(details: unknown): {
  route: string | null
  context: string | null
  stack: string | null
  other: string | null
} {
  const text = details == null ? '' : String(details)
  if (!text.trim()) return { route: null, context: null, stack: null, other: null }
  const lines = text.split('\n')
  let route: string | null = null
  let context: string | null = null
  const rest: string[] = []
  for (const line of lines) {
    if (route == null && line.startsWith('Route: ')) route = line.slice(7).trim()
    else if (context == null && line.startsWith('Request context: '))
      context = line.slice(17).trim()
    else rest.push(line)
  }
  const body = rest.join('\n').trim()
  const looksLikeStack = /\n\s+at\s|^\w*Error[:\s]/m.test(body)
  return {
    route,
    context,
    stack: body && looksLikeStack ? body : null,
    other: body && !looksLikeStack ? body : null
  }
}
