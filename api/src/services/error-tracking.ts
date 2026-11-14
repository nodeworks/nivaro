import { createHash } from 'node:crypto'
import { db } from '../db/index.js'
import { NIVARO_VERSION } from '../version.js'
import { emitOps } from './ops-live.js'

/**
 * Error tracking into nivaro_issues.
 *
 * Repeat errors dedupe by fingerprint (sha256 of source|route|message): an
 * existing OPEN issue with the same fingerprint gets occurrence_count bumped
 * instead of a new row. Resolving an issue and hitting the error again opens
 * a fresh row — regressions surface as new issues, not silent counters.
 *
 * Fire-and-forget: never throws, never blocks the response path.
 */
/** The message an issue keeps (and fingerprints): trimmed to 400 chars, a blank one named. */
export function issueMessage(message: string | null | undefined): string {
  return (message || 'Unknown error').slice(0, 400)
}

/**
 * The issue fingerprint rule: sha256 of `source|route|message` (message through
 * issueMessage). `route` is `METHOD /route/:template` for server errors. Exported so other
 * views (the Traffic Map's error groups) group exactly the way issues dedupe.
 */
export function issueFingerprint(source: string, route: string, message: string): string {
  return createHash('sha256')
    .update(`${source}|${route}|${issueMessage(message)}`)
    .digest('hex')
}

const OCCURRENCE_KEEP = 50
const OCCURRENCE_DAYS = 30

/** Best-effort: store the hit, then keep only the last 50 (and 30 days) for that issue. */
async function recordOccurrence(
  issueId: number,
  opts: { source: string; route: string; userId?: string | null; build?: string | null }
): Promise<void> {
  try {
    if (!(await db.schema.hasTable('nivaro_issue_occurrences'))) return
    await db('nivaro_issue_occurrences').insert({
      issue: issueId,
      occurred_at: new Date(),
      user_id: opts.userId ?? null,
      route: opts.route.slice(0, 300),
      build:
        (opts.build ?? (opts.source === 'server' ? NIVARO_VERSION : null))?.slice(0, 60) ?? null,
      source: opts.source.slice(0, 10)
    })
    await pruneOccurrences(issueId)
  } catch {
    /* the log is best-effort */
  }
}

/** Keep the last 50 hits (and 30 days) of one issue. */
async function pruneOccurrences(issueId: number): Promise<void> {
  const keep = (await db('nivaro_issue_occurrences')
    .where('issue', issueId)
    .orderBy([
      { column: 'occurred_at', order: 'desc' },
      { column: 'id', order: 'desc' }
    ])
    .limit(OCCURRENCE_KEEP)
    .select('id')) as Array<{ id: number }>
  await db('nivaro_issue_occurrences')
    .where('issue', issueId)
    .where((w) => {
      void w
        .whereNotIn(
          'id',
          keep.map((k) => k.id)
        )
        .orWhere('occurred_at', '<', new Date(Date.now() - OCCURRENCE_DAYS * 86_400_000))
    })
    .del()
}

export async function trackError(opts: {
  source: 'server' | 'client'
  route: string
  message: string
  stack?: string | null
  userId?: string | null
  severity?: 'low' | 'medium' | 'high' | 'critical'
  /** Session replay link — the recording (full or error clip) + offset of the error moment. */
  recordingId?: string | null
  recordingOffsetMs?: number | null
  /** #300 — redacted request context (method/route/query keys/body SHAPE, never values). */
  requestContext?: string | null
  /** The frontend build the error came from (client reports); server errors name this API's version. */
  build?: string | null
  /** A caller's own grouping (front-end crashes: signature + screen + release); default source|route|message. */
  fingerprint?: string
  /** Lines written under `Route:` when the issue is opened (front-end crashes: the `Crash:` header). */
  detailsHeader?: string[]
  /** Wait for the occurrence row before returning (a caller that counts recent hits next). */
  awaitOccurrence?: boolean
}): Promise<number | null> {
  // Returns the issue id (new or bumped); null when tracking failed.
  try {
    const message = issueMessage(opts.message)
    const fingerprint = opts.fingerprint ?? issueFingerprint(opts.source, opts.route, message)

    // The occurrence an open issue page streams (admin room): who, where, which build.
    // Names a person by id only — the page resolves it through an admin-only route.
    const announce = (issueId: number, count: number): Promise<void> => {
      const recorded = recordOccurrence(issueId, opts)
      emitOps(`issue:${issueId}`, {
        occurrence: {
          route: opts.route.slice(0, 300),
          source: opts.source,
          user_id: opts.userId ?? null,
          build: opts.build ?? (opts.source === 'server' ? NIVARO_VERSION : null),
          count
        }
      })
      return recorded
    }

    const existing = await db('nivaro_issues')
      .where({ fingerprint })
      .whereIn('status', ['open', 'acknowledged'])
      .first()

    if (existing) {
      await db('nivaro_issues')
        .where({ id: existing.id })
        .update({
          occurrence_count: db.raw('occurrence_count + 1'),
          last_seen_at: new Date(),
          updated_at: new Date(),
          // The LATEST occurrence's replay is the one support wants — an
          // old link on a recurring issue points at a purged recording.
          ...(opts.recordingId
            ? {
                recording_id: opts.recordingId,
                recording_offset_ms: opts.recordingOffsetMs ?? null
              }
            : {})
        })
      const recorded = announce(Number(existing.id), Number(existing.occurrence_count ?? 0) + 1)
      if (opts.awaitOccurrence) await recorded
      return Number(existing.id)
    }

    const details = [
      `Route: ${opts.route}`,
      ...(opts.detailsHeader ?? []),
      opts.requestContext ? `Request context: ${String(opts.requestContext).slice(0, 2000)}` : null,
      opts.stack ? `\n${String(opts.stack).slice(0, 4000)}` : null
    ]
      .filter(Boolean)
      .join('\n')

    const inserted = await db('nivaro_issues')
      .insert({
        title: `[${opts.source}] ${opts.route}: ${message}`.slice(0, 500),
        severity: opts.severity ?? 'high',
        status: 'open',
        source: opts.source,
        details,
        fingerprint,
        occurrence_count: 1,
        last_seen_at: new Date(),
        recording_id: opts.recordingId ?? null,
        recording_offset_ms: opts.recordingOffsetMs ?? null,
        raised_by: opts.userId ?? null,
        created_at: new Date(),
        updated_at: new Date()
      })
      .returning('id')
    // `.returning('id')` yields an OBJECT on this stack
    const first = (inserted as unknown[])[0] as { id?: unknown } | number | undefined
    const id = typeof first === 'object' && first ? Number(first.id) : Number(first)
    if (Number.isFinite(id)) {
      const recorded = announce(id, 1)
      if (opts.awaitOccurrence) await recorded
    }
    return Number.isFinite(id) ? id : null
  } catch {
    /* tracking must never break the request path */
    return null
  }
}

// ─── One issue for many failures of one cause ────────────────────────────────

export interface GroupedHit {
  /** The route of the request that failed (`METHOD /route/:template`). */
  route: string
  userId?: string | null
  at?: Date
}

/** How much of the notes one issue keeps (the newest end). */
const GROUPED_DETAILS_MAX = 8000

/**
 * File ONE issue for a cause that fails many requests on many routes at once (the database
 * refusing connections), instead of one issue per route. `trackError` is unchanged and still
 * files per route; this is for a caller that has already counted the failures.
 *
 * - The fingerprint is `server | route | message` with a FIXED route label, so every request
 *   route and every API process lands on the same open issue. As with trackError, a
 *   resolved issue is left alone and the next report opens a fresh one.
 * - `count` is added to the issue's occurrence count; `hits` (the last 50) become its
 *   occurrences, each naming the request route it stands for; `note` is appended to the
 *   details by the database, so two processes reporting together keep both notes.
 * - Opening the issue is guarded on SQL Server: several processes report the same outage in
 *   the same second, and read-then-insert gave one row per process (production 2026-11-12:
 *   six rows with one fingerprint in 17 ms). The insert is one statement that holds the
 *   fingerprint's range, so exactly one row is opened and everyone adds to it. Other
 *   dialects keep the plain insert.
 *
 * Returns the issue id, or null when it could not be written (the database is still away):
 * the caller keeps its count and reports again. Never throws.
 */
export async function trackGroupedIssue(opts: {
  route: string
  message: string
  severity?: 'low' | 'medium' | 'high' | 'critical'
  count: number
  note: string
  hits: GroupedHit[]
}): Promise<number | null> {
  try {
    const message = issueMessage(opts.message)
    const fingerprint = issueFingerprint('server', opts.route, message)
    const count = Math.max(1, Math.floor(opts.count))
    const findOpen = () =>
      db('nivaro_issues')
        .where({ fingerprint })
        .whereIn('status', ['open', 'acknowledged'])
        .orderBy('id', 'asc')
        .first('id', 'occurrence_count') as Promise<
        { id: number; occurrence_count: number | null } | undefined
      >

    let issue = await findOpen()
    if (!issue) {
      await openGroupedIssue({
        title: `[server] ${opts.route}: ${message}`.slice(0, 500),
        severity: opts.severity ?? 'high',
        details: `Route: ${opts.route}`,
        fingerprint
      })
      issue = await findOpen()
      if (!issue) return null
    }
    const id = Number(issue.id)
    const now = new Date()
    await db('nivaro_issues')
      .where({ id })
      .update({
        occurrence_count: db.raw('occurrence_count + ?', [count]),
        last_seen_at: now,
        updated_at: now,
        details: db.raw('RIGHT(CONCAT(COALESCE(details, ?), ?), ?)', [
          '',
          String(opts.note ?? '').slice(0, 3000),
          GROUPED_DETAILS_MAX
        ])
      })

    try {
      const hits = opts.hits.slice(-OCCURRENCE_KEEP)
      if (hits.length > 0 && (await db.schema.hasTable('nivaro_issue_occurrences'))) {
        await db('nivaro_issue_occurrences').insert(
          hits.map((h) => ({
            issue: id,
            occurred_at: h.at ?? now,
            user_id: h.userId ?? null,
            route: h.route.slice(0, 300),
            build: NIVARO_VERSION.slice(0, 60),
            source: 'server'
          }))
        )
        await pruneOccurrences(id)
      }
    } catch {
      /* the log is best-effort */
    }
    emitOps(`issue:${id}`, {
      occurrence: {
        route: opts.route.slice(0, 300),
        source: 'server',
        user_id: null,
        build: NIVARO_VERSION,
        count: Number(issue.occurrence_count ?? 0) + count
      }
    })
    return id
  } catch {
    /* tracking must never break its caller */
    return null
  }
}

/** Open the issue with a count of zero; the caller adds its own count right after. */
async function openGroupedIssue(row: {
  title: string
  severity: string
  details: string
  fingerprint: string
}): Promise<void> {
  const now = new Date()
  const dialect = (db as unknown as { client?: { config?: { client?: unknown } } }).client?.config
    ?.client
  if (dialect === 'mssql') {
    await db.raw(
      `INSERT INTO nivaro_issues
         (title, severity, status, source, details, fingerprint, occurrence_count, last_seen_at, created_at, updated_at)
       SELECT ?, ?, 'open', 'server', ?, ?, 0, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM nivaro_issues WITH (UPDLOCK, HOLDLOCK)
         WHERE fingerprint = ? AND status IN ('open', 'acknowledged')
       )`,
      [row.title, row.severity, row.details, row.fingerprint, now, now, now, row.fingerprint]
    )
    return
  }
  await db('nivaro_issues').insert({
    title: row.title,
    severity: row.severity,
    status: 'open',
    source: 'server',
    details: row.details,
    fingerprint: row.fingerprint,
    occurrence_count: 0,
    last_seen_at: now,
    created_at: now,
    updated_at: now
  })
}
