/**
 * Error clusters (#20, extends #3159's base — nivaro_issues): issues dedupe on the EXACT message
 * (error-tracking.ts issueFingerprint), so "Record 4471 not found" and "Record 4472 not found"
 * are two issues. A cluster groups them by a normalized signature:
 *
 *   source | message with ids / numbers / quoted values stripped | top stack frame | route template
 *
 * PURE: error-clusters-load.ts reads the issues + occurrences. What a cluster shows is the
 * normalized message (no literal values), counts, first/last seen, routes / screens, how many
 * people, a daily trend from the stored occurrences, and links to replays / request stories.
 */
import { createHash } from 'node:crypto'

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const HEX = /\b(?:0x)?[0-9a-f]{12,}\b/gi
const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?\b/g
const URL_RE = /\bhttps?:\/\/[^\s'"<>)]+/gi
const QUOTED = /(["'`])(?:(?!\1)[^\\\n]|\\.){0,200}\1/g
const NUMBER = /(?<![A-Za-z_])[-+]?\d+(?:[.,]\d+)*(?![A-Za-z_])/g
/** Human ids like CR26-80361, PO-4471, INV_2026_001 (letters then digits with separators). */
const CODE_ID = /\b[A-Z]{1,6}\d{0,4}[-_]\d{2,}(?:[-_]\d+)*\b/g

/** The message with every literal value replaced by a placeholder, whitespace collapsed. */
export function normalizeErrorMessage(message: string | null | undefined): string {
  let m = String(message ?? '').split('\n')[0]
  m = m
    .replace(URL_RE, '<url>')
    .replace(EMAIL, '<email>')
    .replace(UUID, '<id>')
    .replace(ISO_DATE, '<date>')
    .replace(QUOTED, "'…'")
    .replace(CODE_ID, '<id>')
    .replace(HEX, '<id>')
    .replace(NUMBER, '<n>')
    .replace(/(<n>[\s,]*){2,}/g, '<n> ')
    .replace(/\s+/g, ' ')
    .trim()
  return m.slice(0, 300) || 'Unknown error'
}

const FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+)(?::(\d+))?\)?\s*$/
const FF_FRAME_RE = /^\s*([^@\s]*)@(.+?):(\d+)(?::(\d+))?\s*$/

/** A file path without origin, query, build hash or line numbers: "assets/index.js". */
function cleanFile(file: string): string {
  let f = file.replace(/^webpack:\/\/\/?|^file:\/\//, '')
  f = f.replace(/^https?:\/\/[^/]+\//, '')
  f = f.split('?')[0]
  // Vite / webpack chunk hashes: index-AbC123xy.js, chunk.4f3a2b1c.js
  f = f.replace(/[-.][A-Za-z0-9_]{8,}(?=\.(?:m?js|tsx?|jsx)$)/, '')
  // Absolute server paths keep only from src/ or node_modules/ on.
  const at = f.search(/\/(src|dist|node_modules|extensions)\//)
  if (at >= 0) f = f.slice(at + 1)
  return f
}

/**
 * The first frame of a stack that is the app's own code (node internals and node_modules
 * skipped when anything else exists): "updateOne (src/services/items.ts)". Null when no frame
 * parses.
 */
export function topFrame(stack: string | null | undefined): string | null {
  const lines = String(stack ?? '').split('\n')
  const frames: Array<{ fn: string; file: string }> = []
  for (const line of lines) {
    const m = FRAME_RE.exec(line) ?? FF_FRAME_RE.exec(line)
    if (!m) continue
    const fn = (m[1] ?? '').replace(/^async\s+/, '').trim()
    const file = cleanFile(m[2])
    if (!file || file.startsWith('node:') || file === 'native' || file.startsWith('<anonymous>'))
      continue
    frames.push({ fn, file })
    if (frames.length >= 12) break
  }
  const own = frames.find((f) => !f.file.includes('node_modules/')) ?? frames[0]
  if (!own) return null
  return own.fn ? `${own.fn} (${own.file})` : own.file
}

/**
 * A route or page url as a template: "/collections/workflows/85607?x=1" →
 * "/collections/workflows/:id"; "PATCH /api/items/:collection/:id" stays as it is.
 */
export function routeTemplateOf(route: string | null | undefined): string {
  let r = String(route ?? '').trim()
  if (!r) return 'unknown'
  const method = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i.exec(r)
  const prefix = method ? `${method[1].toUpperCase()} ` : ''
  if (method) r = r.slice(method[0].length)
  r = r.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0]
  const segs = r.split('/').map((s) => {
    if (!s || s.startsWith(':')) return s
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)) return ':id'
    if (/^\d+$/.test(s)) return ':id'
    if (/^[A-Z]{1,6}\d{0,4}[-_]\d{2,}/.test(s)) return ':id'
    if (/^[0-9a-f]{16,}$/i.test(s)) return ':id'
    return s
  })
  return `${prefix}${segs.join('/') || '/'}`.slice(0, 200)
}

export function clusterSignature(parts: {
  source: string
  message: string
  frame: string | null
  route: string
}): string {
  return createHash('sha1')
    .update(`${parts.source}|${parts.message}|${parts.frame ?? ''}|${parts.route}`)
    .digest('hex')
    .slice(0, 20)
}

// ─── Building clusters ───────────────────────────────────────────────────────

export interface ClusterIssue {
  id: number
  source: string
  title: string
  /** The stored message is inside the title ("[server] ROUTE: message"); details hold the stack. */
  details: string | null
  status: string
  severity: string | null
  occurrence_count: number
  created_at: string | null
  last_seen_at: string | null
  raised_by: string | null
  recording_id: string | null
  recording_offset_ms: number | null
}

export interface ClusterOccurrence {
  issue: number
  occurred_at: string
  user_id: string | null
  route: string | null
  build: string | null
}

export interface ErrorCluster {
  signature: string
  source: string
  message: string
  frame: string | null
  route: string
  count: number
  issues: number
  issue_ids: number[]
  open: number
  first_seen: string | null
  last_seen: string | null
  users: number
  /** Client errors: the screens (page templates); server errors: the API routes. */
  screens: string[]
  builds: string[]
  /** Count per bucket, oldest first (from stored occurrences — the last 50 per issue). */
  trend: number[]
  severity: string | null
  replays: Array<{ recording_id: string; offset_ms: number | null }>
}

/** "[server] PATCH /api/items/:collection/:id: Record 4471 not found" → the message part. */
export function messageOfIssue(issue: Pick<ClusterIssue, 'title' | 'source'>): {
  route: string
  message: string
} {
  const t = String(issue.title ?? '').replace(/^\[[a-z]+\]\s*/i, '')
  // The route has no ": " in it; the first ": " splits route from message.
  const at = t.indexOf(': ')
  if (at < 0) return { route: 'unknown', message: t }
  return { route: t.slice(0, at), message: t.slice(at + 2) }
}

/** The stack inside an issue's details (after the Route / Request context lines). */
export function stackOfDetails(details: string | null | undefined): string | null {
  const d = String(details ?? '')
  if (!d) return null
  const lines = d.split('\n').filter((l) => !/^(Route|Request context):/.test(l))
  return lines.join('\n').trim() || null
}

const SEV_RANK: Record<string, number> = {
  low: 0,
  info: 0,
  medium: 1,
  warning: 1,
  high: 2,
  error: 2,
  critical: 3
}

export function buildClusters(
  issues: ClusterIssue[],
  occurrences: ClusterOccurrence[],
  opts: { since: number; until: number; buckets: number }
): ErrorCluster[] {
  const byIssue = new Map<number, ClusterOccurrence[]>()
  for (const o of occurrences) {
    const list = byIssue.get(o.issue) ?? []
    list.push(o)
    byIssue.set(o.issue, list)
  }
  const span = Math.max(1, opts.until - opts.since)
  const bucketOf = (at: string): number | null => {
    const t = Date.parse(at)
    if (!Number.isFinite(t) || t < opts.since || t > opts.until) return null
    return Math.min(opts.buckets - 1, Math.floor(((t - opts.since) / span) * opts.buckets))
  }

  const map = new Map<
    string,
    ErrorCluster & { _users: Set<string>; _screens: Map<string, number>; _builds: Set<string> }
  >()
  for (const issue of issues) {
    const { route: titleRoute, message: rawMessage } = messageOfIssue(issue)
    const message = normalizeErrorMessage(rawMessage)
    const frame = topFrame(stackOfDetails(issue.details))
    const route = routeTemplateOf(titleRoute)
    const signature = clusterSignature({ source: issue.source, message, frame, route })
    let c = map.get(signature)
    if (!c) {
      c = {
        signature,
        source: issue.source,
        message,
        frame,
        route,
        count: 0,
        issues: 0,
        issue_ids: [],
        open: 0,
        first_seen: null,
        last_seen: null,
        users: 0,
        screens: [],
        builds: [],
        trend: new Array(opts.buckets).fill(0),
        severity: null,
        replays: [],
        _users: new Set(),
        _screens: new Map(),
        _builds: new Set()
      }
      map.set(signature, c)
    }
    c.issues++
    if (c.issue_ids.length < 50) c.issue_ids.push(issue.id)
    c.count += Math.max(1, Number(issue.occurrence_count) || 1)
    if (
      issue.status === 'open' ||
      issue.status === 'acknowledged' ||
      issue.status === 'in_progress'
    )
      c.open++
    if (issue.created_at && (!c.first_seen || issue.created_at < c.first_seen))
      c.first_seen = issue.created_at
    const last = issue.last_seen_at ?? issue.created_at
    if (last && (!c.last_seen || last > c.last_seen)) c.last_seen = last
    if (issue.raised_by) c._users.add(issue.raised_by.toLowerCase())
    if ((SEV_RANK[issue.severity ?? ''] ?? -1) > (SEV_RANK[c.severity ?? ''] ?? -1))
      c.severity = issue.severity
    if (issue.recording_id && c.replays.length < 5)
      c.replays.push({ recording_id: issue.recording_id, offset_ms: issue.recording_offset_ms })
    const occ = byIssue.get(issue.id) ?? []
    for (const o of occ) {
      if (o.user_id) c._users.add(o.user_id.toLowerCase())
      const screen = routeTemplateOf(o.route ?? titleRoute)
      c._screens.set(screen, (c._screens.get(screen) ?? 0) + 1)
      if (o.build) c._builds.add(o.build)
      const b = bucketOf(o.occurred_at)
      if (b != null) c.trend[b]++
    }
    if (occ.length === 0) {
      c._screens.set(route, (c._screens.get(route) ?? 0) + 1)
      const b = last ? bucketOf(last) : null
      if (b != null) c.trend[b] += 1
    }
  }

  return [...map.values()]
    .map(({ _users, _screens, _builds, ...c }) => ({
      ...c,
      users: _users.size,
      screens: [..._screens.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([s]) => s),
      builds: [..._builds].slice(0, 8)
    }))
    .sort((a, b) => b.count - a.count || String(b.last_seen).localeCompare(String(a.last_seen)))
}
