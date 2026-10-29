/**
 * Request story (#19): one request id → one plain-words timeline across what the system kept
 * about it — the API log row, the kept trace (phases, hooks, SQL statement TEXT, realtime
 * events), and the integration chain the request started (activity writes, workflow moves,
 * flows, pushes, partner calls, notifications, mail).
 *
 * PURE assembly (request-story-load.ts reads the sources). Every part is optional: a trace the
 * ring let go, a log row still in the logger's batch, a request older than the log's 14 days —
 * each missing part becomes a sentence in `missing`, never a failed story.
 *
 * Never shown: bound values, query strings, request/response bodies, field VALUES.
 */

export interface StoryLog {
  method: string
  /** The path without its query string. */
  path: string
  /** The route template ("PATCH /api/items/:collection/:id"). */
  route: string
  status: number
  latency_ms: number
  created_at: string | null
  who: string | null
  caller_kind: 'user' | 'api_key' | 'anonymous'
  instance: string | null
  chain_id: string | null
  /** First line of the stored error, masked. */
  error: string | null
  graphql_operation: string | null
}

export interface StoryTraceSpan {
  phase: string
  ms: number
  at: number
  detail?: string
  queries?: number
}

export interface StoryTrace {
  total_ms: number
  queries: number
  sql_ms: number
  spans: StoryTraceSpan[]
  top_sql: Array<{ sql: string; n: number; ms: number }>
  emits?: Array<{ event: string; n: number }>
}

/** A chain step, as event-path/exact.ts builds them (bodies off). */
export interface StoryStep {
  key: string
  kind: string
  at: string
  who?: string | null
  record?: { collection: string; item: string; label?: string | null } | null
  summary: string
  failed?: boolean
  reason?: string | null
  detail?: Record<string, unknown> | null
}

export interface StoryParts {
  requestId: string
  log: StoryLog | null
  /** The request is fresh enough that its log row may still be in the logger's batch. */
  logPending?: boolean
  /** The log row is past the log's retention (or the table has no request ids). */
  logReason?: string | null
  trace: StoryTrace | null
  /** Why there is no trace ("requests under 1000 ms are not traced"). */
  traceReason?: string | null
  steps: StoryStep[] | null
  stepWarnings?: string[]
}

export type StoryEventKind =
  | 'request'
  | 'phase'
  | 'hook'
  | 'sql'
  | 'write'
  | 'transition'
  | 'flow'
  | 'push'
  | 'call'
  | 'notify'
  | 'mail'
  | 'emit'
  | 'error'
  | 'other'

export interface StoryEvent {
  kind: StoryEventKind
  /** Milliseconds from the request's start, when known. */
  offset_ms: number | null
  at: string | null
  text: string
  ms?: number | null
  failed?: boolean
  record?: { collection: string; item: string; label?: string | null } | null
}

export interface RequestStory {
  request_id: string
  found: boolean
  headline: string
  status: number | null
  at: string | null
  total_ms: number | null
  route: string | null
  who: string | null
  chain_id: string | null
  timeline: StoryEvent[]
  sql: {
    count: number
    ms: number
    statements: Array<{ sql: string; n: number; ms: number }>
  } | null
  hooks: Array<{ name: string; ms: number }>
  emits: Array<{ event: string; n: number }>
  notified: number
  sources: {
    log: 'found' | 'pending' | 'missing'
    trace: 'kept' | 'missing'
    chain: 'found' | 'empty' | 'none'
  }
  missing: string[]
}

// ─── Words ───────────────────────────────────────────────────────────────────

/** "purchase_orders" → "purchase order". */
export function nounOf(collection: string): string {
  const w = collection.replace(/[_-]+/g, ' ').trim().toLowerCase()
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

export function msText(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '?'
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** What the request did, from its method + path ("Saved workflow 85607"). */
export function actionPhrase(method: string, path: string, gqlOp?: string | null): string {
  const m = method.toUpperCase()
  const items = /^\/api\/items\/([A-Za-z0-9_]+)(?:\/([^/?#]+))?(\/.*)?$/.exec(path)
  if (items) {
    const [, col, id, rest] = items
    const noun = nounOf(col)
    if (rest) return `${m} ${noun} ${id}${rest}`
    if (!id)
      return m === 'POST'
        ? `Created a ${noun}`
        : m === 'GET'
          ? `Listed ${col.replace(/_/g, ' ')}`
          : `${m} ${col}`
    if (m === 'PATCH' || m === 'PUT') return `Saved ${noun} ${id}`
    if (m === 'DELETE') return `Deleted ${noun} ${id}`
    if (m === 'GET') return `Opened ${noun} ${id}`
  }
  const tr = /\/(workflows|pipelines)\/.*\/(transition|instance)/.exec(path)
  if (tr && m === 'POST') return 'Moved a record along its pipeline'
  if (/\/graphql$/.test(path)) return gqlOp ? `GraphQL ${gqlOp}` : 'GraphQL request'
  return `${m} ${path}`
}

/** "hook:efp-ops:workflows:update:before" + label → "efp-ops:forecast-guard". */
export function hookName(phase: string, detail?: string): string {
  const [, ext = 'core', col = '', action = '', timing = ''] = phase.split(':')
  if (detail?.trim()) return `${ext}:${detail.trim()}`
  return `${ext} ${timing}-${action}${col ? ` on ${col}` : ''}`
}

/** A partner call step's partner and status ("Fusion answered 200"). */
function callFacts(step: StoryStep): { partner: string; status: string; ms: number | null } {
  const [partner, status] = step.summary.split(' answered ')
  const d = step.detail ?? {}
  const ms = typeof d.duration_ms === 'number' ? d.duration_ms : null
  return { partner: partner || 'partner', status: status ?? '?', ms }
}

const STEP_KIND: Record<string, StoryEventKind> = {
  write: 'write',
  transition: 'transition',
  flow: 'flow',
  push: 'push',
  attempt: 'push',
  partner_call: 'call',
  notify: 'notify',
  mail: 'mail'
}

/** Writes read "Updated workflow 85607 (status, owner)" — field NAMES only, never values. */
function stepText(step: StoryStep): string {
  const d = step.detail
  if (step.kind === 'write' && d && d.type === 'changes' && Array.isArray(d.changes)) {
    const names = (d.changes as Array<{ label?: string; field?: string }>)
      .map((c) => c.label ?? c.field)
      .filter(Boolean)
      .slice(0, 6)
    return names.length ? `${step.summary} (${names.join(', ')})` : step.summary
  }
  if (step.kind === 'partner_call') {
    const c = callFacts(step)
    return `${c.partner} answered ${c.status}${c.ms != null ? ` in ${msText(c.ms)}` : ''}`
  }
  return step.summary
}

// ─── Assembly ────────────────────────────────────────────────────────────────

export function assembleRequestStory(parts: StoryParts): RequestStory {
  const { log, trace } = parts
  const missing: string[] = []
  const timeline: StoryEvent[] = []

  const startMs = log?.created_at ? Date.parse(log.created_at) - (log.latency_ms ?? 0) : null
  const offsetOf = (at: string | null | undefined): number | null => {
    if (startMs == null || !at) return null
    const t = Date.parse(at)
    return Number.isFinite(t) ? Math.max(0, Math.round(t - startMs)) : null
  }

  // The request itself.
  if (log) {
    timeline.push({
      kind: 'request',
      offset_ms: 0,
      at: startMs != null ? new Date(startMs).toISOString() : null,
      text: `${log.who ?? (log.caller_kind === 'anonymous' ? 'Someone not signed in' : 'A caller')} sent ${log.method} ${log.path}`,
      ms: log.latency_ms,
      failed: log.status >= 400
    })
  } else if (parts.logPending) {
    missing.push(
      'The API log row is not written yet (it is batched for a few seconds) — reload in a moment.'
    )
  } else {
    missing.push(
      parts.logReason ??
        'No API log row has this request id — it may be older than the log keeps (14 days), or it never reached /api.'
    )
  }

  // Trace: phases, hooks, SQL, realtime events.
  const hooks: Array<{ name: string; ms: number }> = []
  if (trace) {
    for (const s of trace.spans) {
      if (s.phase.startsWith('hook:')) {
        const name = hookName(s.phase, s.detail)
        hooks.push({ name, ms: Math.round(s.ms) })
        timeline.push({
          kind: 'hook',
          offset_ms: Math.round(s.at),
          at: null,
          text: `Hook ${name} ran`,
          ms: Math.round(s.ms)
        })
      } else if (s.ms >= 5 || s.phase === 'auth') {
        timeline.push({
          kind: 'phase',
          offset_ms: Math.round(s.at),
          at: null,
          text: `${s.phase}${s.detail ? ` · ${s.detail}` : ''}${s.queries ? ` · ${plural(s.queries, 'SQL statement')}` : ''}`,
          ms: Math.round(s.ms)
        })
      }
    }
  } else {
    missing.push(
      parts.traceReason ??
        'No trace was kept for this request — phase timings, hooks and SQL are not known.'
    )
  }

  // Chain: what the request wrote and set off.
  const steps = parts.steps ?? []
  let notified = 0
  const notifiedNames = new Set<string>()
  for (const st of steps) {
    if (st.kind === 'request') continue
    const kind = STEP_KIND[st.kind] ?? 'other'
    if (kind === 'notify') {
      const r = String((st.detail as { recipient?: unknown } | null)?.recipient ?? st.summary)
      if (!notifiedNames.has(r)) {
        notifiedNames.add(r)
        notified++
      }
    }
    timeline.push({
      kind,
      offset_ms: offsetOf(st.at),
      at: st.at,
      text: stepText(st),
      failed: !!st.failed,
      record: st.record ?? null,
      ...(st.failed && st.reason ? { text: `${stepText(st)} — ${st.reason}` } : {})
    })
  }
  if (!log?.chain_id) {
    if (log)
      missing.push(
        'The request carries no chain id, so its writes and pushes cannot be joined to it.'
      )
  } else if (parts.steps == null) {
    missing.push('The writes, pushes and notifications of this request could not be read.')
  }
  for (const w of parts.stepWarnings ?? []) missing.push(`Could not read ${w}`)

  if (log && log.status >= 400) {
    timeline.push({
      kind: 'error',
      offset_ms: log.latency_ms,
      at: log.created_at,
      text: `Answered ${log.status}${log.error ? `: ${log.error}` : ''}`,
      failed: true
    })
  }

  const emits = trace?.emits ?? []
  for (const e of emits) {
    timeline.push({
      kind: 'emit',
      offset_ms: null,
      at: null,
      text: `Sent ${plural(e.n, 'live update')} (${e.event})`
    })
  }

  // Order: known offsets first by time, unknown last (in the order they came).
  const order = timeline.map((e, i) => ({ e, i }))
  order.sort((a, b) => {
    const x = a.e.offset_ms
    const y = b.e.offset_ms
    if (x == null && y == null) return a.i - b.i
    if (x == null) return 1
    if (y == null) return -1
    return x - y || a.i - b.i
  })

  const sql = trace
    ? {
        count: trace.queries,
        ms: trace.sql_ms,
        statements: trace.top_sql.map((s) => ({ sql: s.sql, n: s.n, ms: Math.round(s.ms) }))
      }
    : null

  return {
    request_id: parts.requestId,
    found: !!(log || trace || steps.length),
    headline: headlineOf(parts, { hooks, notified, emits }),
    status: log?.status ?? null,
    at: log?.created_at ?? null,
    total_ms: log?.latency_ms ?? trace?.total_ms ?? null,
    route: log?.route ?? null,
    who: log?.who ?? null,
    chain_id: log?.chain_id ?? null,
    timeline: order.map((o) => o.e),
    sql,
    hooks,
    emits,
    notified,
    sources: {
      log: log ? 'found' : parts.logPending ? 'pending' : 'missing',
      trace: trace ? 'kept' : 'missing',
      chain: !log?.chain_id ? 'none' : steps.length ? 'found' : 'empty'
    },
    missing
  }
}

/** "Saved workflow 85607 · 3 SQL statements · hook efp-ops:forecast-guard 120 ms · pushed to
 *  Fusion (200, 1.4 s) · 2 people notified" */
export function headlineOf(
  parts: StoryParts,
  extra: {
    hooks: Array<{ name: string; ms: number }>
    notified: number
    emits: Array<{ n: number }>
  }
): string {
  const { log, trace } = parts
  const bits: string[] = []
  if (log) {
    const action = actionPhrase(log.method, log.path, log.graphql_operation)
    bits.push(log.status >= 400 ? `${action} — failed ${log.status}` : action)
  } else if (parts.steps?.length) {
    bits.push('Request (no log row)')
  } else if (!trace) {
    return 'Nothing is kept about this request id.'
  } else {
    bits.push('Request')
  }
  if (trace) bits.push(`${plural(trace.queries, 'SQL statement')} (${msText(trace.sql_ms)})`)
  const slowest = [...extra.hooks].sort((a, b) => b.ms - a.ms)[0]
  if (slowest) {
    bits.push(
      extra.hooks.length > 1
        ? `${extra.hooks.length} hooks, slowest ${slowest.name} ${msText(slowest.ms)}`
        : `hook ${slowest.name} ${msText(slowest.ms)}`
    )
  }
  const steps = parts.steps ?? []
  const writes = steps.filter((s) => s.kind === 'write').length
  if (writes > 1) bits.push(`${writes} records written`)
  const moves = steps.filter((s) => s.kind === 'transition').length
  if (moves) bits.push(plural(moves, 'pipeline move'))
  for (const c of steps.filter((s) => s.kind === 'partner_call').slice(0, 3)) {
    const f = callFacts(c)
    bits.push(`pushed to ${f.partner} (${f.status}${f.ms != null ? `, ${msText(f.ms)}` : ''})`)
  }
  const failedPushes = steps.filter((s) => s.kind === 'push' && s.failed).length
  if (failedPushes) bits.push(`${plural(failedPushes, 'push', 'pushes')} failed`)
  if (extra.notified) bits.push(`${plural(extra.notified, 'person', 'people')} notified`)
  const live = extra.emits.reduce((n, e) => n + e.n, 0)
  if (live) bits.push(plural(live, 'live update'))
  if (log) bits.push(`${msText(log.latency_ms)} total`)
  return bits.join(' · ')
}

/** A 32-hex trace id (OTLP spelling) → the dashed request id; anything else as given. */
export function normalizeRequestId(raw: string): string | null {
  const t = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(t)) return t
  if (/^[0-9a-f]{32}$/.test(t))
    return `${t.slice(0, 8)}-${t.slice(8, 12)}-${t.slice(12, 16)}-${t.slice(16, 20)}-${t.slice(20)}`
  return null
}
