import { createHash } from 'node:crypto'
import { db } from '../db/index.js'
import { NIVARO_VERSION } from '../version.js'
import { noteIssueWrite } from './issue-raise.js'
import { readableIssueForServer } from './issue-readable-server.js'
import { emitOps } from './ops-live.js'

/**
 * Error tracking into nivaro_issues.
 *
 * Repeat errors dedupe by fingerprint (sha256 of source|route|message, or a
 * writer's own stable key — `stableIssueKey`, for system issues whose message
 * carries times/counts/ids): an existing OPEN (or acknowledged) issue with the
 * same fingerprint gets occurrence_count bumped instead of a new row.
 * Resolving an issue and hitting the error again opens a fresh row —
 * regressions surface as new issues, not silent counters.
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
  // One database statement timing out is one issue whichever route ran it (issue-key.ts).
  const timedOut = source === 'server' ? dbTimeoutStatement(issueMessage(message)) : null
  if (timedOut) return stableIssueKey('db-timeout', timedOut.key)
  return createHash('sha256')
    .update(`${source}|${route}|${issueMessage(message)}`)
    .digest('hex')
}

// The stable-key rule for system issues lives in a leaf module (the cron plugin imports it).
export { dbTimeoutStatement, normalizeIssueText, stableIssueKey } from './issue-key.js'

import { dbTimeoutStatement, stableIssueKey } from './issue-key.js'

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
  /**
   * A caller's own grouping (front-end crashes: signature + screen + release; system issues whose
   * message carries times/counts/ids: `stableIssueKey`); default source|route|message.
   */
  fingerprint?: string
  /**
   * A repeat of an open issue rewrites its details from THIS occurrence (`Message:` line, summary,
   * stack, header) — for stable-key system issues, whose message changes between occurrences, so
   * the issue shows the latest time / count / statement. The title stays the first one's;
   * `last_seen_at` and the occurrence log carry when it happened again. Off: details stay the
   * first occurrence's (request errors, whose first stack is as good as the next).
   */
  refreshDetails?: boolean
  /** Lines written under `Route:` when the issue is opened (front-end crashes: the `Crash:` header). */
  detailsHeader?: string[]
  /** Wait for the occurrence row before returning (a caller that counts recent hits next). */
  awaitOccurrence?: boolean
  /**
   * The title a person reads, when the caller has one. Unset: a server issue whose message is
   * one of the known machine shapes (services/issue-readable.ts — missed cron runs, deadlocks,
   * pool pressure …) is stored with its readable title. Either way the fingerprint stays
   * `source|route|message` (or the caller's own `fingerprint`), so new hits group with issues
   * raised before titles were readable,
   * and the machine message is kept in details (`Message:`) for search and support.
   */
  title?: string
  /** What it means and what to do, stored as the details' `Summary:` line. */
  summary?: string
}): Promise<number | null> {
  // Returns the issue id (new or bumped); null when tracking failed.
  try {
    const message = issueMessage(opts.message)
    const fingerprint = opts.fingerprint ?? issueFingerprint(opts.source, opts.route, message)
    // A statement timeout groups across routes (issueFingerprint): its title names the
    // statement, not the first route, and its details follow the latest route.
    const timedOut =
      !opts.fingerprint && opts.source === 'server' ? dbTimeoutStatement(message) : null
    const refreshDetails = opts.refreshDetails ?? !!timedOut
    const fallbackTitle = timedOut
      ? `Database statement timed out after ${Math.round(timedOut.ms / 1000)} s: ${timedOut.sql.replace(/\s+/g, ' ')}`.slice(
          0,
          300
        )
      : undefined
    const fallbackSummary = timedOut
      ? 'The database did not answer this statement in time. Every route that ran it while the database was busy or locked adds to this issue; Route shows the latest one.'
      : undefined

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

    // The readable title + summary of a known machine shape (services/issue-readable.ts).
    const describe = async () =>
      opts.title || opts.source !== 'server'
        ? null
        : await readableIssueForServer({
            title: `[${opts.source}] ${opts.route}: ${message}`,
            source: opts.source
          })
    // The details an issue stores; `Message:` keeps the machine text a readable title hides.
    const detailsFor = (summary: string, withMessage: boolean): string =>
      [
        `Route: ${opts.route}`,
        ...(opts.detailsHeader ?? []),
        summary ? `Summary: ${summary}` : null,
        // a readable title keeps the machine message here: admin search and support read it
        withMessage ? `Message: ${message.replace(/\s+/g, ' ')}` : null,
        opts.requestContext
          ? `Request context: ${String(opts.requestContext).slice(0, 2000)}`
          : null,
        opts.stack ? `\n${String(opts.stack).slice(0, 4000)}` : null
      ]
        .filter(Boolean)
        .join('\n')

    const findOpen = () =>
      db('nivaro_issues').where({ fingerprint }).whereIn('status', ['open', 'acknowledged']).first()

    const bump = async (existing: { id: unknown; occurrence_count?: unknown }) => {
      // A stable-key issue shows its latest occurrence (the `Message:` line is always written,
      // so a reader of an older machine-titled row still finds the latest text in details).
      let refreshed: string | null = null
      if (refreshDetails) {
        const readable = await describe()
        const summary = (opts.summary ?? readable?.description ?? fallbackSummary ?? '')
          .replace(/\s+/g, ' ')
          .trim()
        refreshed = detailsFor(summary, true)
      }
      await db('nivaro_issues')
        .where({ id: existing.id })
        .update({
          occurrence_count: db.raw('occurrence_count + 1'),
          last_seen_at: new Date(),
          updated_at: new Date(),
          ...(refreshed != null ? { details: refreshed } : {}),
          // The LATEST occurrence's replay is the one support wants — an
          // old link on a recurring issue points at a purged recording.
          ...(opts.recordingId
            ? {
                recording_id: opts.recordingId,
                recording_offset_ms: opts.recordingOffsetMs ?? null
              }
            : {})
        })
      noteIssueWrite(Number(existing.id), 'recurred', {
        fingerprint,
        hits: [{ userId: opts.userId ?? null, at: new Date() }]
      })
      const recorded = announce(Number(existing.id), Number(existing.occurrence_count ?? 0) + 1)
      if (opts.awaitOccurrence) await recorded
      return Number(existing.id)
    }

    const existing = await findOpen()
    if (existing) return await bump(existing)

    const readable = await describe()
    const title = (opts.title ?? readable?.title ?? fallbackTitle ?? '').replace(/\s+/g, ' ').trim()
    const summary = (opts.summary ?? readable?.description ?? fallbackSummary ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    const details = detailsFor(summary, !!title)

    const id = await insertIssueOnce({
      title: (title || `[${opts.source}] ${opts.route}: ${message}`).slice(0, 500),
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
    if (id === 'exists') {
      // Another request opened it between our read and our insert (three timeouts in the same
      // second filed three issues and three GitLab tickets, prod 2026-11-19): add to that one.
      const opened = await findOpen()
      return opened ? await bump(opened) : null
    }
    if (Number.isFinite(id)) {
      noteIssueWrite(id, 'raised', {
        fingerprint,
        hits: [{ userId: opts.userId ?? null, at: new Date() }]
      })
      const recorded = announce(id, 1)
      if (opts.awaitOccurrence) await recorded
    }
    return Number.isFinite(id) ? id : null
  } catch {
    /* tracking must never break the request path */
    return null
  }
}

/**
 * Open an issue unless an open one with its fingerprint already exists — in ONE statement on
 * SQL Server (the range lock on the fingerprint makes concurrent reporters queue, and only the
 * first inserts). Returns the new id, or 'exists' when someone else opened it first. Other
 * dialects keep the plain insert (they never raced in practice; tests run there).
 */
export async function insertIssueOnce(row: Record<string, unknown>): Promise<number | 'exists'> {
  const dialect = (db as unknown as { client?: { config?: { client?: unknown } } }).client?.config
    ?.client
  if (dialect === 'mssql') {
    const cols = Object.keys(row)
    const res = (await db.raw(
      `INSERT INTO nivaro_issues (${cols.map((c) => `[${c}]`).join(', ')})
       OUTPUT INSERTED.id
       SELECT ${cols.map(() => '?').join(', ')}
       WHERE NOT EXISTS (
         SELECT 1 FROM nivaro_issues WITH (UPDLOCK, HOLDLOCK)
         WHERE fingerprint = ? AND status IN ('open', 'acknowledged')
       )`,
      [...cols.map((c) => row[c] as never), row.fingerprint as never]
    )) as unknown as Array<{ id?: unknown }>
    const first = Array.isArray(res) ? res[0] : undefined
    return first?.id != null ? Number(first.id) : 'exists'
  }
  const inserted = await db('nivaro_issues').insert(row).returning('id')
  // `.returning('id')` yields an OBJECT on this stack
  const first = (inserted as unknown[])[0] as { id?: unknown } | number | undefined
  return typeof first === 'object' && first ? Number(first.id) : Number(first)
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
    const opened = !issue
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

    noteIssueWrite(id, opened ? 'raised' : 'recurred', {
      fingerprint,
      count,
      hits: opts.hits.map((h) => ({ userId: h.userId ?? null, at: h.at }))
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
