/**
 * Front-end crash tracking (Issue Log → Crashes). Builds on the issue log (nivaro_issues +
 * nivaro_issue_occurrences, error-tracking.ts) — no table of its own:
 *
 * - `recordCrash` files one POST /issues/client report: scrubbed message + stack, grouped by
 *   signature + screen + release (crash-signature.ts) into ONE issue row whose fingerprint is
 *   that key. A row opened for a signature whose family was never seen in another release says
 *   `new_in=<release>` in its `Crash:` header line; otherwise `seen_in=<earliest release>`.
 * - Admin bundles: the minified frames are mapped back to source from the hidden source maps on
 *   this process's disk (crash-sourcemap.ts), appended under `Source-mapped stack:`.
 * - `maybeAlertCrash`: a crash new in the app's CURRENT release that reached
 *   CRASH_ALERT_MIN_HITS hits (default 3) or CRASH_ALERT_MIN_PEOPLE people (default 2) within
 *   CRASH_ALERT_WINDOW_MIN minutes (default 15) tells every active administrator once, through
 *   notifyUser (category `crashes`, so Profile → Notification rules apply). "Once" is an
 *   `Alerted: <iso>` line claimed on the issue row by one conditional UPDATE, so two replicas
 *   never both send it.
 * - `listCrashes` is the read behind GET /issues/crashes.
 *
 * Every function here is best-effort: a crash report must never fail the request.
 */
import { db } from '../db/index.js'
import { NIVARO_VERSION } from '../version.js'
import { logActivity } from './activity.js'
import {
  type CrashKind,
  type CrashMeta,
  crashAlertText,
  crashErrorName,
  crashFamily,
  crashFingerprint,
  crashFrames,
  crashHeaderLines,
  crashResolvedStackOf,
  crashSignature,
  crashStackOf,
  frameLabel,
  isCurrentRelease,
  judgeableRelease,
  newInRelease,
  parseCrashMeta,
  scrubCrashText,
  shouldAlertCrash
} from './crash-signature.js'
import { resolveCrashFrames } from './crash-sourcemap.js'
import { selectInChunks, whereInList } from './db-batch.js'
import { messageOfIssue } from './error-clusters.js'
import { trackError } from './error-tracking.js'
import { getApp } from './io-holder.js'
import { compareBuilds } from './sticky-refresh.js'

const OPEN = ['open', 'acknowledged']

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback
}

export function crashAlertConfig(): { minHits: number; minPeople: number; windowMin: number } {
  return {
    minHits: envInt('CRASH_ALERT_MIN_HITS', 3, 1, 1000),
    minPeople: envInt('CRASH_ALERT_MIN_PEOPLE', 2, 1, 1000),
    windowMin: envInt('CRASH_ALERT_WINDOW_MIN', 15, 1, 1440)
  }
}

// ─── Recording one report ────────────────────────────────────────────────────

export interface CrashInput {
  app: string
  release: string
  kind: CrashKind
  /** Route pattern of the screen (`/collections/:id/:id`). */
  screen: string
  name?: string | null
  message: string
  stack?: string | null
  userId?: string | null
  recordingId?: string | null
  recordingOffsetMs?: number | null
}

export interface CrashDeps {
  findOpen(fingerprint: string): Promise<{ id: number; details: string | null } | null>
  /** Releases a family was seen in before (from the issue log). */
  familyReleases(family: string): Promise<string[]>
  track: typeof trackError
  /** Append the source-mapped stack to a freshly opened row (fire and forget). */
  resolve(issueId: number, stack: string): Promise<void>
  alert(issueId: number): Promise<boolean>
}

async function findOpenDb(fingerprint: string) {
  const row = (await db('nivaro_issues')
    .where({ fingerprint })
    .whereIn('status', OPEN)
    .orderBy('id', 'asc')
    .first('id', db.raw('SUBSTRING(details, 1, 1200) as details'))) as
    | { id: number; details: string | null }
    | undefined
  return row ? { id: Number(row.id), details: row.details } : null
}

async function familyReleasesDb(family: string): Promise<string[]> {
  const rows = (await db('nivaro_issues')
    .where('source', 'client')
    .where('details', 'like', `%family=${family.replace(/[^0-9a-f]/g, '')}%`)
    .orderBy('id', 'desc')
    .limit(200)
    .select(db.raw('SUBSTRING(details, 1, 1200) as details'))) as Array<{ details: string | null }>
  return rows.map((r) => parseCrashMeta(r.details)?.release ?? '').filter(Boolean)
}

async function resolveDb(issueId: number, stack: string): Promise<void> {
  const resolved = await resolveCrashFrames(crashFrames(stack))
  if (!resolved) return
  await db('nivaro_issues')
    .where({ id: issueId })
    .update({
      details: db.raw('CONCAT(details, ?)', [
        `\n\nSource-mapped stack:\n${resolved.slice(0, 3000)}`
      ])
    })
}

const defaultDeps: CrashDeps = {
  findOpen: findOpenDb,
  familyReleases: familyReleasesDb,
  track: trackError,
  resolve: resolveDb,
  alert: (id) => maybeAlertCrash(id)
}

/** File one crash report. Returns the issue id (or null) and the crash's header. */
export async function recordCrash(
  input: CrashInput,
  deps: CrashDeps = defaultDeps
): Promise<{ issueId: number | null; meta: Omit<CrashMeta, 'alerted_at'>; opened: boolean }> {
  const stack = input.stack ? scrubCrashText(input.stack, 6000) : null
  const rawMessage = scrubCrashText(input.message, 400).trim() || 'Unknown error'
  const name = crashErrorName(input.name, stack)
  // "TypeError: x is not a function" — the stored message names its error type once.
  const message = rawMessage.startsWith(`${name}:`) ? rawMessage : `${name}: ${rawMessage}`
  const app = input.app
  const screen = input.screen
  const release = input.release
  const signature = crashSignature({ name, message: rawMessage, stack })
  const family = crashFamily({ app, name, message: rawMessage, stack, screen })
  const fingerprint = crashFingerprint({ app, signature, screen, release })
  const frame = frameLabel(crashFrames(stack, 1)[0])

  const existing = await deps.findOpen(fingerprint).catch(() => null)
  let meta: Omit<CrashMeta, 'alerted_at'>
  const prior = existing ? parseCrashMeta(existing.details) : null
  if (prior) {
    meta = { ...prior }
  } else {
    const seen = await deps.familyReleases(family).catch(() => [] as string[])
    meta = {
      app,
      release,
      kind: input.kind,
      signature,
      family,
      frame,
      ...newInRelease(release, seen)
    }
  }
  const issueId = await deps.track({
    source: 'client',
    route: screen,
    message,
    stack,
    userId: input.userId ?? null,
    build: release,
    recordingId: input.recordingId ?? null,
    recordingOffsetMs: input.recordingOffsetMs ?? null,
    fingerprint,
    detailsHeader: crashHeaderLines(meta),
    awaitOccurrence: true
  })
  const opened = issueId != null && !existing
  if (issueId != null) {
    if (opened && stack && app === 'admin') void deps.resolve(issueId, stack).catch(() => {})
    void deps.alert(issueId).catch(() => {})
  }
  return { issueId, meta, opened }
}

// ─── The alert ───────────────────────────────────────────────────────────────

export interface AlertDeps {
  loadIssue(id: number): Promise<{
    id: number
    title: string
    details: string | null
    recording_id: string | null
  } | null>
  recentHits(id: number, sinceMs: number): Promise<{ hits: number; people: number }>
  /** The newest release of `app` with a crash in the last week (null = none). */
  newestRelease(app: string): Promise<string | null>
  /** Claim the alert on the row (true = this caller sends it). */
  claim(id: number, at: Date): Promise<boolean>
  admins(): Promise<string[]>
  notify(userId: string, note: AlertNote): Promise<void>
  log(id: number, comment: string): Promise<void>
  now(): number
  apiVersion: string | null
}

export interface AlertNote {
  subject: string
  message: string
  issueId: number
  label: string
}

async function newestReleaseDb(app: string): Promise<string | null> {
  const rows = (await db('nivaro_issues')
    .where('source', 'client')
    .where('last_seen_at', '>=', new Date(Date.now() - 7 * 86_400_000))
    .where('details', 'like', `%app=${app.replace(/[^\w-]/g, '')};%`)
    .orderBy('last_seen_at', 'desc')
    .limit(300)
    .select(db.raw('SUBSTRING(details, 1, 600) as details'))) as Array<{ details: string | null }>
  let best: string | null = null
  for (const r of rows) {
    const rel = parseCrashMeta(r.details)?.release
    if (!judgeableRelease(rel)) continue
    if (!best || compareBuilds(rel, best) === 1) best = rel
  }
  return best
}

const alertDeps: AlertDeps = {
  loadIssue: async (id) => {
    const row = (await db('nivaro_issues')
      .where({ id })
      .first('id', 'title', 'recording_id', db.raw('SUBSTRING(details, 1, 1500) as details'))) as
      | { id: number; title: string; details: string | null; recording_id: string | null }
      | undefined
    return row ?? null
  },
  recentHits: async (id, sinceMs) => {
    const rows = (await db('nivaro_issue_occurrences')
      .where('issue', id)
      .where('occurred_at', '>=', new Date(sinceMs))
      .select('user_id')) as Array<{ user_id: string | null }>
    const people = new Set(rows.map((r) => String(r.user_id ?? '').toLowerCase()).filter(Boolean))
    return { hits: rows.length, people: people.size }
  },
  newestRelease: newestReleaseDb,
  claim: async (id, at) => {
    const n = await db('nivaro_issues')
      .where({ id })
      .where((w) => void w.whereNull('details').orWhere('details', 'not like', 'Alerted: %'))
      .update({
        details: db.raw('CONCAT(?, COALESCE(details, ?))', [`Alerted: ${at.toISOString()}\n`, ''])
      })
    return Number(n) > 0
  },
  admins: async () => {
    const rows = (await db('nivaro_users as u')
      .join('nivaro_roles as r', 'r.id', 'u.role')
      .where('r.admin_access', true)
      .where('u.status', 'active')
      .whereNull('u.account_kind')
      .limit(25)
      .select('u.id')) as Array<{ id: string }>
    return rows.map((r) => String(r.id))
  },
  notify: async (userId, note) => {
    const app = getApp()
    if (!app) return
    const { notifyUser } = await import('./notification-channels.js')
    await notifyUser(app, userId, {
      subject: note.subject,
      message: note.message,
      category: 'crashes',
      collection: 'nivaro_issues',
      item: String(note.issueId),
      target: { kind: 'issue', id: note.issueId, action: 'review' },
      source: { kind: 'crash_alert', label: note.label, id: note.issueId },
      why: 'You are an administrator and a crash that is new in this release is spreading.'
    })
  },
  log: async (id, comment) => {
    await logActivity({
      action: 'crash-alert',
      user: null,
      collection: 'nivaro_issues',
      item: String(id),
      comment
    })
  },
  now: () => Date.now(),
  apiVersion: NIVARO_VERSION
}

/** Tell administrators about a crash new in the current release, once. True when sent. */
export async function maybeAlertCrash(
  issueId: number,
  deps: AlertDeps = alertDeps
): Promise<boolean> {
  try {
    const issue = await deps.loadIssue(issueId)
    const meta = issue ? parseCrashMeta(issue.details) : null
    if (!issue || !meta) return false
    // Cheap refusals first: an alerted row, an old family or a dev build never reads further.
    if (meta.alerted_at || meta.new_in !== meta.release || !judgeableRelease(meta.release))
      return false
    const cfg = crashAlertConfig()
    const now = deps.now()
    const recent = await deps.recentHits(issueId, now - cfg.windowMin * 60_000)
    const newestSeen = await deps.newestRelease(meta.app).catch(() => null)
    const current = isCurrentRelease(meta.app, meta.release, {
      apiVersion: deps.apiVersion,
      newestSeen
    })
    if (
      !shouldAlertCrash({
        meta,
        current,
        hits: recent.hits,
        people: recent.people,
        minHits: cfg.minHits,
        minPeople: cfg.minPeople
      })
    )
      return false
    if (!(await deps.claim(issueId, new Date(now)))) return false
    const { route: screen, message } = messageOfIssue({ title: issue.title, source: 'client' })
    const text = crashAlertText({
      app: meta.app,
      release: meta.release,
      screen,
      message,
      hits: recent.hits,
      people: recent.people,
      windowMin: cfg.windowMin,
      replay: !!issue.recording_id
    })
    const admins = await deps.admins().catch(() => [] as string[])
    for (const id of admins) {
      await deps
        .notify(id, { ...text, issueId, label: `${meta.app} ${meta.release}` })
        .catch(() => undefined)
    }
    await deps
      .log(issueId, `${meta.app} ${meta.release}: ${recent.hits} hits, ${recent.people} people`)
      .catch(() => undefined)
    return true
  } catch {
    return false
  }
}

// ─── The Crashes view ────────────────────────────────────────────────────────

export interface CrashRow {
  id: number
  title: string
  message: string
  screen: string
  app: string
  release: string
  kind: CrashKind
  status: string
  severity: string
  count: number
  first_seen: string | null
  last_seen: string | null
  people: number
  people_names: string[]
  new_in: string | null
  seen_in: string | null
  frame: string | null
  stack: string | null
  resolved_stack: string | null
  recording_id: string | null
  recording_offset_ms: number | null
  alerted_at: string | null
  /** Filed before crash grouping: no `Crash:` header (release read from its hits). */
  legacy: boolean
}

export interface ReleaseSummary {
  app: string
  release: string
  crashes: number
  hits: number
  new: number
  people: number
}

export interface CrashList {
  crashes: CrashRow[]
  releases: string[]
  screens: string[]
  apps: string[]
  /** Per app: its newest release with crashes, and what crashed in it. */
  since_release: ReleaseSummary[]
  truncated: boolean
}

const ISSUE_CAP = 1000
const iso = (v: unknown): string | null => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const byReleaseDesc = (a: string, b: string) => (compareBuilds(b, a) ?? 0) || b.localeCompare(a)

/** Every client crash seen in the window, grouped rows as stored, newest first. */
export async function listCrashes(opts: {
  days: number
  release?: string | null
  screen?: string | null
  app?: string | null
  status?: string | null
}): Promise<CrashList> {
  const days = Math.min(90, Math.max(1, Math.round(opts.days || 14)))
  const since = new Date(Date.now() - days * 86_400_000)
  const rows = (await db('nivaro_issues')
    .where('source', 'client')
    .where((w) => {
      void w
        .where('last_seen_at', '>=', since)
        .orWhere((x) => void x.whereNull('last_seen_at').where('created_at', '>=', since))
    })
    .orderBy('last_seen_at', 'desc')
    .limit(ISSUE_CAP + 1)
    .select(
      'id',
      'title',
      'status',
      'severity',
      'occurrence_count',
      'created_at',
      'last_seen_at',
      'raised_by',
      'recording_id',
      'recording_offset_ms',
      db.raw('SUBSTRING(details, 1, 8000) as details')
    )) as Array<Record<string, unknown>>
  const truncated = rows.length > ISSUE_CAP
  const issues = rows.slice(0, ISSUE_CAP)
  const ids = issues.map((r) => Number(r.id))

  const occ = (await selectInChunks(ids, 500, (chunk) =>
    whereInList(db('nivaro_issue_occurrences'), 'issue', chunk).select('issue', 'user_id', 'build')
  ).catch(() => [])) as Array<{ issue: number; user_id: string | null; build: string | null }>
  const users = new Map<number, Set<string>>()
  const builds = new Map<number, string>()
  for (const o of occ) {
    const set = users.get(Number(o.issue)) ?? new Set<string>()
    if (o.user_id) set.add(String(o.user_id).toLowerCase())
    users.set(Number(o.issue), set)
    if (o.build && !builds.has(Number(o.issue))) builds.set(Number(o.issue), String(o.build))
  }
  for (const r of issues) {
    if (!r.raised_by) continue
    const set = users.get(Number(r.id)) ?? new Set<string>()
    set.add(String(r.raised_by).toLowerCase())
    users.set(Number(r.id), set)
  }
  const everyone = [...new Set([...users.values()].flatMap((s) => [...s]))]
  const names = new Map<string, string>()
  if (everyone.length > 0) {
    const people = (await selectInChunks(everyone, 500, (chunk) =>
      whereInList(db('nivaro_users'), 'id', chunk).select('id', 'first_name', 'last_name', 'email')
    ).catch(() => [])) as Array<{
      id: string
      first_name: string | null
      last_name: string | null
      email: string | null
    }>
    for (const p of people)
      names.set(
        String(p.id).toLowerCase(),
        [p.first_name, p.last_name].filter(Boolean).join(' ') || String(p.email ?? 'Someone')
      )
  }

  const all: CrashRow[] = issues.map((r) => {
    const id = Number(r.id)
    const details = (r.details as string | null) ?? null
    const meta = parseCrashMeta(details)
    const { route, message } = messageOfIssue({ title: String(r.title ?? ''), source: 'client' })
    const people = [...(users.get(id) ?? [])]
    return {
      id,
      title: String(r.title ?? ''),
      message,
      screen: route,
      app: meta?.app ?? 'unknown',
      release: meta?.release ?? builds.get(id) ?? 'unknown',
      kind: meta?.kind ?? 'error',
      status: String(r.status ?? 'open'),
      severity: String(r.severity ?? 'high'),
      count: Math.max(1, Number(r.occurrence_count) || 1),
      first_seen: iso(r.created_at),
      last_seen: iso(r.last_seen_at ?? r.created_at),
      people: people.length,
      people_names: people.slice(0, 12).map((u) => names.get(u) ?? 'Unknown person'),
      new_in: meta?.new_in ?? null,
      seen_in: meta?.seen_in ?? null,
      frame: meta?.frame ?? null,
      stack: crashStackOf(details),
      resolved_stack: crashResolvedStackOf(details),
      recording_id: (r.recording_id as string | null) ?? null,
      recording_offset_ms:
        r.recording_offset_ms != null ? Number(r.recording_offset_ms) : (null as number | null),
      alerted_at: meta?.alerted_at ?? null,
      legacy: !meta
    }
  })

  const releases = [...new Set(all.map((c) => c.release))].sort(byReleaseDesc)
  const screens = [...new Set(all.map((c) => c.screen))].sort()
  const apps = [...new Set(all.map((c) => c.app))].sort()

  // Per app, its newest judgeable release (the admin: the API's own version when it has one).
  const since_release: ReleaseSummary[] = []
  for (const app of apps) {
    const mine = all.filter((c) => c.app === app && judgeableRelease(c.release))
    let current = mine.map((c) => c.release).sort(byReleaseDesc)[0] ?? null
    if (app === 'admin' && judgeableRelease(NIVARO_VERSION)) current = NIVARO_VERSION
    if (!current) continue
    const inIt = mine.filter((c) => c.release === current)
    const who = new Set(inIt.flatMap((c) => [...(users.get(c.id) ?? [])]))
    since_release.push({
      app,
      release: current,
      crashes: inIt.length,
      hits: inIt.reduce((s, c) => s + c.count, 0),
      new: inIt.filter((c) => c.new_in === current).length,
      people: who.size
    })
  }

  const crashes = all.filter(
    (c) =>
      (!opts.release || c.release === opts.release) &&
      (!opts.screen || c.screen === opts.screen) &&
      (!opts.app || c.app === opts.app) &&
      (!opts.status ||
        (opts.status === 'open'
          ? ['open', 'acknowledged', 'in_progress'].includes(c.status)
          : c.status === opts.status))
  )
  return { crashes, releases, screens, apps, since_release, truncated }
}
