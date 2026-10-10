import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'
import { decodeChunk, encodeChunk } from '../routes/session-recordings.js'
import {
  type CutResult,
  chunkEvents,
  cutEvents,
  fmtClock,
  summarizeCut
} from './session-replay-cut.js'
import { buildEventRail } from './session-replay-rail.js'
import { ensureRecordingHot } from './session-replay-storage.js'

/**
 * Cut a range of a stored recording into a recording of its own (#1366).
 *
 * The cut lands as app='clip' in nivaro_session_recordings with re-encoded
 * chunks in nivaro_session_events — the same storage every replay reads, so
 * the player, the rail and deep links work on it unchanged. It belongs to the
 * same person and environment as its source (the screen is theirs); its
 * started_at is its own first instant, so the rail lines up with it.
 *
 * A clip raised as an issue purges with retention like any recording; a clip
 * saved to the library (#1415) is exempt, since the library row points at it.
 */

export interface SourceRecording {
  id: string
  user: string
  app: string | null
  origin: string | null
  meta: string | null
  masquerade_admin: string | null
}

export type CutFailure = { status: 400 | 404 | 422; error: string }

export interface StoredCut {
  recordingId: string
  source: SourceRecording
  cut: CutResult
}

/** Shortest range worth keeping. */
export const MIN_CLIP_MS = 1_000

/** Every event of a recording, in chunk order; corrupt chunks are skipped. */
export async function loadRecordingEvents(recordingId: string): Promise<unknown[]> {
  // #1411 — a cold recording is read back from object storage first.
  await ensureRecordingHot(recordingId, { wait: true }).catch(() => null)
  const chunks = (await db('nivaro_session_events')
    .where({ recording: recordingId })
    .orderBy('seq', 'asc')
    .select('events')) as Array<{ events: string }>
  const events: unknown[] = []
  for (const c of chunks) {
    try {
      events.push(...(JSON.parse(decodeChunk(c.events)) as unknown[]))
    } catch {
      /* a partial cut beats none */
    }
  }
  return events
}

/** `{from_ms, to_ms}` from a request body; null when unusable. */
export function parseRange(body: unknown): { fromMs: number; toMs: number } | null {
  const b = (body ?? {}) as { from_ms?: unknown; to_ms?: unknown }
  const from = Number(b.from_ms)
  const to = Number(b.to_ms)
  if (b.from_ms == null || b.to_ms == null || !Number.isFinite(from) || !Number.isFinite(to)) {
    return null
  }
  const lo = Math.max(0, Math.floor(Math.min(from, to)))
  const hi = Math.floor(Math.max(from, to))
  if (hi - lo < MIN_CLIP_MS) return null
  return { fromMs: lo, toMs: hi }
}

/** Library tags: trimmed, lower-cased, de-duplicated, at most 10 of 40 chars (array or comma list). */
export function parseTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : []
  const out: string[] = []
  for (const t of list) {
    const v = String(t ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .slice(0, 40)
    if (v && !out.includes(v)) out.push(v)
    if (out.length >= 10) break
  }
  // The column holds the JSON array: keep it under 500 characters.
  while (out.length > 0 && JSON.stringify(out).length > 500) out.pop()
  return out
}

/** The source's events cut to the range, without storing anything. */
export async function cutSource(
  recordingId: string,
  fromMs: number,
  toMs: number
): Promise<{ source: SourceRecording; cut: CutResult } | CutFailure> {
  const source = (await db('nivaro_session_recordings')
    .where({ id: recordingId })
    .first('id', 'user', 'app', 'origin', 'meta', 'masquerade_admin')) as
    | SourceRecording
    | undefined
  if (!source) return { status: 404, error: 'Recording not found' }
  const events = await loadRecordingEvents(source.id)
  if (events.length === 0) return { status: 404, error: 'No events' }
  const cut = cutEvents(events, fromMs, toMs)
  if (!cut || cut.events.length < 2) {
    return { status: 422, error: 'Nothing replayable in that range' }
  }
  return { source, cut }
}

/** Cut the range and store it as a new app='clip' recording. */
export async function storeCut(
  recordingId: string,
  fromMs: number,
  toMs: number
): Promise<StoredCut | CutFailure> {
  const res = await cutSource(recordingId, fromMs, toMs)
  if ('status' in res) return res
  const { source, cut } = res
  const id = randomUUID()
  const chunks = chunkEvents(cut.events).map(encodeChunk)
  const now = new Date()
  await db.transaction(async (trx) => {
    await trx('nivaro_session_recordings').insert({
      id,
      user: source.user,
      app: 'clip',
      origin: source.origin ?? null,
      meta: source.meta ?? null,
      masquerade_admin: source.masquerade_admin ?? null,
      started_at: new Date(cut.startTs),
      ended_at: new Date(cut.endTs),
      last_event_at: new Date(cut.endTs),
      event_count: cut.events.length,
      byte_size: chunks.reduce((n, c) => n + c.length, 0),
      truncated: false
    })
    // One row per chunk: a chunk can be megabytes, and a multi-row insert
    // of those is a single giant statement.
    for (let seq = 0; seq < chunks.length; seq++) {
      await trx('nivaro_session_events').insert({
        recording: id,
        seq,
        events: chunks[seq],
        created_at: now
      })
    }
  })
  return { recordingId: id, source, cut }
}

/**
 * The issue text for a clip: where it opens, its console errors and the
 * person's API requests in its window (from the event rail), each with its
 * time inside the clip.
 */
export async function clipIssueDetails(
  stored: StoredCut,
  note: string | null,
  sourceName: string | null
): Promise<{ route: string | null; details: string; errorCount: number; requestCount: number }> {
  const { cut, source } = stored
  const summary = summarizeCut(cut)
  let requests: Array<{ at: string; label: string }> = []
  try {
    const rail = await buildEventRail({
      id: stored.recordingId,
      user: source.user,
      app: null,
      started_at: new Date(cut.startTs),
      ended_at: new Date(cut.endTs),
      last_event_at: new Date(cut.endTs)
    })
    requests = rail.items.filter((i) => i.kind === 'request')
  } catch {
    /* the issue stands without its request rows */
  }
  const at = (iso: string) => fmtClock(Math.max(0, Date.parse(iso) - cut.startTs))
  const lines: string[] = [
    `Raised from a session replay clip: ${fmtClock(cut.fromMs)}–${fmtClock(cut.toMs)} of recording ${source.id}${sourceName ? ` (${sourceName})` : ''}.`,
    `Route: ${summary.route ?? 'unknown'}`
  ]
  if (note) lines.push('', note)
  lines.push('', `Console errors in the clip (${summary.errors.length}):`)
  if (summary.errors.length === 0) lines.push('  none')
  for (const e of summary.errors.slice(0, 30)) lines.push(`  ${fmtClock(e.offset)} ${e.text}`)
  if (summary.errors.length > 30) lines.push(`  … ${summary.errors.length - 30} more`)
  lines.push('', `Requests in the clip (${requests.length}):`)
  if (requests.length === 0) lines.push('  none recorded')
  for (const r of requests.slice(0, 60)) lines.push(`  ${at(r.at)} ${r.label}`)
  if (requests.length > 60) lines.push(`  … ${requests.length - 60} more`)
  return {
    route: summary.route,
    details: lines.join('\n').slice(0, 8000),
    errorCount: summary.errors.length,
    requestCount: requests.length
  }
}
