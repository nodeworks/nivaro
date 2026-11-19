/**
 * Server issue titles in plain words.
 *
 * The issue log's server-generated titles are stored machine text — ISO times, job ids, table
 * and column names:
 *
 *   [server] cron/miss: Cron "team-alerts" missed its expected run at 2026-11-18T05:50:00.000Z …
 *   Rollup drift: inventory_request.mdsi_units_shipped (35/500 rows stale)
 *
 * `readableIssue` recognises those shapes and says them the way a person would — "Scheduled job
 * "Team alerts" didn't run at 12:50 AM (last ran 11:50 PM)" — with a short description of what
 * it means and what to do, and a place in words ("Scheduled job") instead of the route. The
 * stored title is never changed: search, grouping (fingerprints) and GitLab link matching keep
 * reading it. Newer rows store a readable title already and keep the machine text in `details`
 * (`Message:` line, read here so times still render in the reader's own zone) plus a `Summary:`
 * line (the description). Anything unrecognised returns null: callers show the title as it is.
 *
 * TWIN: admin/src/pages/issues/issue-readable.ts and api/src/services/issue-readable.ts are
 * byte-identical (api/src/test/unit/services/issue-readable.test.ts compares them). No imports.
 */

export interface IssueLabelLookup {
  /** A collection's display name (plural preferred), or null when unknown. */
  collection?: (collection: string) => string | null | undefined
  /** A field's label, or null when unknown. */
  field?: (collection: string, field: string) => string | null | undefined
}

export interface ReadableOpts {
  /** IANA zone the times read in; unset = the runtime's own. */
  timeZone?: string | null
  /** Add the zone's short name to times ("12:50 AM EST") — for text read outside the app. */
  zoneName?: boolean
  /** Now, for "yesterday" (tests). */
  now?: number
  labels?: IssueLabelLookup
}

export interface ReadableIssue {
  /** Which shape it was ("cron-miss", "rollup-drift", …; "summary" = a stored readable title). */
  kind: string
  title: string
  /** What it means and what to do, in a sentence or two. */
  description: string | null
  /** Where it came from, in words ("Scheduled job", "Database"). */
  place: string | null
  /** Collections and fields the words name, for a label lookup. */
  names: { collections: string[]; fields: Array<{ collection: string; field: string }> }
}

export interface IssueTextInput {
  title: string | null | undefined
  details?: string | null
  /**
   * server | client | manual. Only server-written issues are read: a browser report or a
   * person's own issue carries text anyone could type, so it is never re-worded. Unset = the
   * title's `[server]` / `[client]` prefix decides (unprefixed = server-written).
   */
  source?: string | null
}

// ─── Words ───────────────────────────────────────────────────────────────────

/** `ext:efp-ops:forecast-watch-scan` → `forecast-watch-scan`. */
export function stripExtensionPrefix(id: string): string {
  return id.replace(/^ext:[^:]+:/, '')
}

/** A machine name in words: `forecast-watch-scan` → `Forecast watch scan`. */
export function humanizeName(id: string): string {
  const words = stripExtensionPrefix(String(id ?? ''))
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_.:/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : String(id ?? '')
}

/** A scheduled job's name in words. */
export function jobName(id: string): string {
  return humanizeName(id)
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

function collectionWords(c: string, o: ReadableOpts): string {
  const own = o.labels?.collection?.(c)
  return own?.trim() ? own.trim() : humanizeName(c)
}

function fieldWords(c: string, f: string, o: ReadableOpts): string {
  const own = o.labels?.field?.(c, f)
  return own?.trim() ? own.trim() : humanizeName(f)
}

// ─── Times ───────────────────────────────────────────────────────────────────

function fmt(d: Date, o: ReadableOpts, parts: Intl.DateTimeFormatOptions): string {
  const tz = o.timeZone || undefined
  try {
    return new Intl.DateTimeFormat('en-US', { ...parts, timeZone: tz }).format(d)
  } catch {
    // an unknown zone name: the runtime's own
    return new Intl.DateTimeFormat('en-US', parts).format(d)
  }
}

const dayOf = (d: Date, o: ReadableOpts) =>
  fmt(d, o, { year: 'numeric', month: '2-digit', day: '2-digit' })

/** "12:50 AM", "12:50 AM yesterday", "12:50 AM on Nov 14" (a past year adds it). */
export function readableTime(iso: string, o: ReadableOpts = {}): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const clock = fmt(d, o, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    ...(o.zoneName ? { timeZoneName: 'short' } : {})
  })
  const now = new Date(o.now ?? Date.now())
  const day = dayOf(d, o)
  if (day === dayOf(now, o)) return clock
  if (day === dayOf(new Date(now.getTime() - 86_400_000), o)) return `${clock} yesterday`
  const sameYear = fmt(d, o, { year: 'numeric' }) === fmt(now, o, { year: 'numeric' })
  return `${clock} on ${fmt(d, o, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })}`
}

/** 1200 → "1.2 s", 640 → "640 ms". */
function duration(ms: number): string {
  if (!Number.isFinite(ms)) return `${ms} ms`
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`
}

// ─── Where it came from ──────────────────────────────────────────────────────

const PLACES: Array<[RegExp, string]> = [
  [/^cron\//, 'Scheduled job'],
  [/^(deadlock-sweep|pool-monitor|db\/)/, 'Database'],
  [/^(rollup-drift|dead-link-sweep|subscription-integrity)/, 'Data check'],
  [/^restart-impact/, 'Server restart'],
  [/^(pipeline\/|action-journal)/, 'Workflow'],
  [/^(external-api-contract\/|outbound-contract:)/, 'Partner connection'],
  [/^outbox/, 'Delivery queue'],
  [/^(log-alert\/)/, 'Log alert'],
  [/^realtime\//, 'Live updates'],
  [/^(maintenance-window|post-deploy-smoke)/, 'Deploy check'],
  [/^runtime-monitor/, 'Server health'],
  [/^swallow\//, 'Background step'],
  [/^oidc-callback/, 'Sign-in'],
  [/^api-changelog/, 'API change']
]

/**
 * A route, job or screen in words: `cron/miss` → "Scheduled job", `GET /api/items/:c` →
 * "Server request", `/collections/x/5` → "Screen". Null when it is not one of those.
 */
export function placeOf(where: string | null | undefined): string | null {
  const w = String(where ?? '').trim()
  if (!w) return null
  for (const [re, label] of PLACES) if (re.test(w)) return label
  if (/^[A-Z]{3,7}\s+\//.test(w)) return 'Server request'
  if (w.startsWith('/')) return 'Screen'
  return null
}

// ─── Shapes ──────────────────────────────────────────────────────────────────

type Shape = {
  kind: string
  route: RegExp | null
  match: RegExp
  build: (
    m: RegExpExecArray,
    o: ReadableOpts
  ) => Omit<ReadableIssue, 'kind' | 'place' | 'names'> & {
    place?: string
    names?: ReadableIssue['names']
  }
}

const NO_NAMES = (): ReadableIssue['names'] => ({ collections: [], fields: [] })

const SHAPES: Shape[] = [
  {
    kind: 'cron-miss',
    route: /^cron\/miss$/,
    match:
      /^Cron "([^"]+)" missed its expected run at (\S+?)(?: \((?:last ran (\S+?)|(never recorded))\))?$/,
    build: (m, o) => ({
      title: `Scheduled job "${jobName(m[1])}" didn't run at ${readableTime(m[2], o)}${
        m[3] ? ` (last ran ${readableTime(m[3], o)})` : m[4] ? ' (no earlier run recorded)' : ''
      }`,
      description:
        'It was due but never started. Open Jobs to run it now if its work matters, and check that scheduled jobs are running on this server.',
      place: 'Scheduled job'
    })
  },
  {
    kind: 'cron-skip',
    route: /^cron\/watchdog$/,
    match: /^Cron "([^"]+)" tick skipped — the previous tick has been running for (\d+) minute/,
    build: (m) => ({
      title: `Scheduled job "${jobName(m[1])}" skipped a run: the last one was still going after ${plural(Number(m[2]), 'minute')}`,
      description:
        'One run overlapped the next. If this keeps happening the job takes longer than its schedule allows — open Jobs to see how long its runs take.',
      place: 'Scheduled job'
    })
  },
  {
    kind: 'cron-hung',
    route: /^cron\/watchdog$/,
    match: /^Cron "([^"]+)" has been running for over (\d+) minutes/,
    build: (m) => ({
      title: `Scheduled job "${jobName(m[1])}" has been running for over ${plural(Number(m[2]), 'minute')} and may be stuck`,
      description:
        'Its work may have stopped happening. Open Jobs to look at the run, and run it again once it has ended.',
      place: 'Scheduled job'
    })
  },
  {
    kind: 'cron-ticks-off',
    route: /^cron\/ticks-off$/,
    match: /^Scheduled run of "([^"]+)" started on a process with ticks off/,
    build: (m) => ({
      title: `Scheduled job "${jobName(m[1])}" ran on a server that is set not to run jobs`,
      description:
        'Another server is meant to run scheduled jobs. Ask whoever runs the servers to check this one’s settings.',
      place: 'Scheduled job'
    })
  },
  {
    kind: 'rollup-drift',
    route: null,
    match: /^Rollup drift: ([A-Za-z_][\w]*)\.([A-Za-z_][\w]*) \((\d+)\/(\d+) rows stale\)$/,
    build: (m, o) => ({
      title: `Stored total "${fieldWords(m[1], m[2], o)}" on ${collectionWords(m[1], o)} is out of date for ${Number(m[3]).toLocaleString('en-US')} of ${plural(Number(m[4]), 'sampled record')}`,
      description:
        'Some records show a saved total that no longer matches what it adds up from. Recalculate the field in Data model, then find what stopped keeping it current.',
      place: 'Data check',
      names: { collections: [m[1]], fields: [{ collection: m[1], field: m[2] }] }
    })
  },
  {
    kind: 'deadlock',
    route: /^deadlock-sweep$/,
    match: /^SQL deadlock at (\S+) \(only reads lost\)(?:.*? — other side: (.+))?$/s,
    build: (m, o) => ({
      title: `A database read gave way to ${m[2] ? m[2].trim() : 'another statement'} at ${readableTime(m[1], o)}`,
      description:
        "Only reads lost the lock race (a background check or a list), and they are simply asked again — nobody's save was cancelled. Worth a look only if it repeats at busy times.",
      place: 'Database'
    })
  },
  {
    kind: 'deadlock',
    route: /^deadlock-sweep$/,
    match: /^SQL deadlock at (\S+)/,
    build: (m, o) => ({
      title: `Two database updates blocked each other at ${readableTime(m[1], o)}`,
      description:
        'The database cancelled one so the other could finish; whoever was saving may have seen an error and had to try again. Repeats point at a query that needs tuning.',
      place: 'Database'
    })
  },
  {
    kind: 'process-stall',
    route: /^process-stall$/,
    match:
      /^Process stalled ([\d.]+)s \((main loop blocked|helper threads backed up|every database connection in use)\) on (\S+)/,
    build: (m) => ({
      title: `A server process froze for ${m[1]} s (${m[2]})`,
      description:
        m[2] === 'main loop blocked'
          ? 'Every request on that process waited while one piece of work held the processor (or a long memory clean-up ran). The details list what was running; a repeat on the same request is the one to fix.'
          : m[2] === 'helper threads backed up'
            ? 'File reads, database connection lookups and compression queued behind slow work — usually the shared file storage answering slowly. The details list what was running.'
            : 'Every database connection on that process was in use with requests waiting. The Connections tab (Database) shows who holds them.',
      place: 'Server'
    })
  },
  {
    kind: 'pool-pressure',
    route: /^pool-monitor$/,
    match:
      /^DB connection pool under pressure: p95 acquire wait (\d+)ms, every connection busy (\d+)% of the last (\d+)s/,
    build: (m) => ({
      title: `The app ran short of database connections: all were busy ${m[2]}% of the time`,
      description: `Pages may have felt slow — 1 request in 20 waited ${duration(Number(m[1]))} or more for a connection. Look for long reports, imports or jobs running at that time.`,
      place: 'Database'
    })
  },
  {
    kind: 'restart-impact',
    route: /^restart-impact$/,
    match: /^Restart interrupted (\d+) running job\(s\): (.*?) — /,
    build: (m) => {
      const names = m[2]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(jobName)
      return {
        title: `A restart stopped ${plural(Number(m[1]), 'scheduled job')} part-way${names.length ? `: ${names.join(', ')}` : ''}`,
        description: 'Those runs did not finish. Run the ones that matter again from Jobs.',
        place: 'Server restart'
      }
    }
  },
  {
    kind: 'dead-links',
    route: /^dead-link-sweep$/,
    match: /^(\d+) record link\(s\) point at deleted records/,
    build: (m) => ({
      title: `${plural(Number(m[1]), 'record link')} still point${Number(m[1]) === 1 ? 's' : ''} at deleted records`,
      description:
        'The nightly clean-up could not remove them. Open Data Integrity → Orphans to see and repair them.',
      place: 'Data check'
    })
  },
  {
    kind: 'subscriptions',
    route: /^subscription-integrity$/,
    match: /^Deactivated (\d+) subscription\(s\) pointing at deleted views\/records/,
    build: (m) => ({
      title: `Turned off ${plural(Number(m[1]), 'notification subscription')} for views or records that were deleted`,
      description: 'Nothing to do: nobody gets alerts about something that is gone.',
      place: 'Data check'
    })
  },
  {
    kind: 'workflow-autostart',
    route: /^pipeline\/autostart$/,
    match: /^Workflow auto-start failed for ([A-Za-z_][\w]*) (\S+) while /,
    build: (m, o) => ({
      title: `A ${collectionWords(m[1], o)} record (${m[2]}) didn't start its workflow`,
      description:
        'The record was saved but did not enter its workflow. Open it and start the workflow by hand; the reason is in the details.',
      place: 'Workflow',
      names: { collections: [m[1]], fields: [] }
    })
  },
  {
    kind: 'quiet-failures',
    route: /^swallow\//,
    match: /^Silent-failure site "[^"]+" has swallowed (\d+) errors in the last hour/,
    build: (m) => ({
      title: `A background step failed quietly ${Number(m[1]).toLocaleString('en-US')} times in the last hour`,
      description:
        'Something kept failing without showing anyone an error. The latest message is in the details.',
      place: 'Background step'
    })
  },
  {
    kind: 'sign-in',
    route: /^oidc-callback$/,
    match: /^OIDC callback failed: /,
    build: () => ({
      title: 'Microsoft sign-in failed',
      description:
        'Someone could not finish signing in. If it keeps happening, check the sign-in app in Settings → Microsoft.',
      place: 'Sign-in'
    })
  },
  {
    kind: 'outbox-dead',
    route: /^outbox$/,
    match: /^Outbox row \S+ \(([^)]+)\) dead after (\d+) attempts/,
    build: (m) => ({
      title: `A queued ${humanizeName(m[1]).toLowerCase()} delivery gave up after ${plural(Number(m[2]), 'try', 'tries')}`,
      description: 'It will not be tried again on its own. The reason is in the details.',
      place: 'Delivery queue'
    })
  }
]

// ─── Reading a row ───────────────────────────────────────────────────────────

const PREFIX = /^\s*\[(?:server|client)\]\s+/i
const ROUTE = /^([a-z][\w.-]*(?:\/[\w.:-]+)*):\s+/

/**
 * The keys the SERVER wrote at the top of `details` (trackError: `Route:`, its own header lines,
 * `Summary:`, `Message:`; rollup drift: `Summary:`, `Message:`). Only the leading block is read —
 * it ends at the first blank line or the `Request context:` line — because what follows (the
 * request context, the stack, sampled values) can hold text a caller sent: a `Summary:` line
 * there must never re-word the issue. The first occurrence of a key wins.
 */
export function serverHeader(details: string | null | undefined): {
  route: string | null
  summary: string | null
  message: string | null
} {
  const out = {
    route: null as string | null,
    summary: null as string | null,
    message: null as string | null
  }
  for (const line of String(details ?? '').split('\n')) {
    if (!line.trim() || line.startsWith('Request context:')) break
    const m = /^(Route|Summary|Message): (.+)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase() as 'route' | 'summary' | 'message'
    // Summary and Message are written last, in that order: nothing is read after Message
    if (out[key] == null) out[key] = m[2].trim() || null
    if (key === 'message') break
  }
  return out
}

/** Whether the row's words were written by the server (only those are re-worded). */
export function serverWritten(input: IssueTextInput): boolean {
  const source = String(input.source ?? '')
    .trim()
    .toLowerCase()
  if (source) return source === 'server'
  return !/^\s*\[client\]/i.test(String(input.title ?? ''))
}

/** The route + machine message a stored title (or a newer row's details) carries. */
export function machineText(
  input: IssueTextInput
): Array<{ route: string | null; message: string }> {
  const out: Array<{ route: string | null; message: string }> = []
  const title = String(input.title ?? '').trim()
  if (PREFIX.test(title)) {
    const rest = title.replace(PREFIX, '')
    const r = ROUTE.exec(rest)
    out.push(r ? { route: r[1], message: rest.slice(r[0].length) } : { route: null, message: rest })
  } else if (title) out.push({ route: null, message: title })
  const head = serverHeader(input.details)
  if (head.message) out.unshift({ route: head.route, message: head.message })
  return out
}

/** The `Summary:` line a newer row stores in its server-written header, if any. */
export function storedSummary(details: string | null | undefined): string | null {
  return serverHeader(details).summary
}

/**
 * A server-generated issue in plain words, or null when the title is not one of the known
 * shapes and the row stores no summary (show the title as it is).
 */
export function readableIssue(input: IssueTextInput, o: ReadableOpts = {}): ReadableIssue | null {
  if (!serverWritten(input)) return null
  for (const { route, message } of machineText(input)) {
    for (const s of SHAPES) {
      if (route && s.route && !s.route.test(route)) continue
      const m = s.match.exec(message)
      if (!m) continue
      const b = s.build(m, o)
      return {
        kind: s.kind,
        title: b.title,
        description: storedSummary(input.details) ?? b.description,
        place: b.place ?? placeOf(route),
        names: b.names ?? NO_NAMES()
      }
    }
  }
  const summary = storedSummary(input.details)
  if (!summary) return null
  const route = serverHeader(input.details).route
  return {
    kind: 'summary',
    title: String(input.title ?? '').trim(),
    description: summary,
    place: placeOf(route),
    names: NO_NAMES()
  }
}
