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
  // ─ v2 (the drill-down page). All optional: older callers and tests leave them out. ─
  /** How the caller signed in: session | token | api_key | masquerade | oauth | none. */
  auth?: string | null
  user_id?: string | null
  api_key_id?: number | null
  ip?: string | null
  user_agent?: string | null
  /** The request carried a query string (its VALUES are never shown). */
  has_query?: boolean
  /** The log kept the JSON body of an integration write (never shown here). */
  body_kept?: boolean
  graphql?: {
    kind: string | null
    depth: number | null
    selections: number | null
    errors: number | null
  } | null
  /** An MCP tool call (migration 480): connection id, client, tool, outcome. */
  mcp?: {
    conn: string | null
    client: string | null
    tool: string | null
    outcome: string | null
  } | null
  /** How the row was found (request id, or the root /graphql alias by chain / time). */
  matched_by?: string | null
}

export interface StoryTraceSpan {
  phase: string
  ms: number
  at: number
  detail?: string
  queries?: number
  /** v2 — stable id within the trace. */
  seq?: number
  /** v2 — the one statement this phase ran over and over (an N+1): TEXT only. */
  repeat?: { sql: string; n: number; ms: number } | null
  /** v2 — `select *` against long-text tables inside this phase. */
  wide?: Array<{ table: string; n: number }> | null
}

/** v2 — a kept statement with what the loader worked out (shape id, tables). TEXT only. */
export interface StoryTraceStatement {
  sql: string
  n: number
  ms: number
  sha?: string
  tables?: string[]
}

export interface StoryTrace {
  total_ms: number
  queries: number
  sql_ms: number
  spans: StoryTraceSpan[]
  top_sql: StoryTraceStatement[]
  emits?: Array<{ event: string; n: number }>
  /** v2 — `select *` reads of long-text tables over the whole request. */
  wide?: Array<{ table: string; n: number }>
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
  /** v2 — the step this one sits under (`submission:12`, `notification:4`…). */
  parent?: string | null
  /** v2 — the partner API a push / call went to. */
  api_id?: number | null
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
  // ─ v2: everything the drill-down page shows, each part down to its last leaf. ─
  request: StoryRequest | null
  caller: StoryCaller | null
  trace: StoryTraceDetail | null
  effects: StoryEffect[]
}

export interface StoryRequest {
  method: string
  path: string
  route: string
  status: number
  /** When the request started (log time minus its latency). */
  started_at: string | null
  finished_at: string | null
  latency_ms: number
  instance: string | null
  auth: string | null
  ip: string | null
  user_agent: string | null
  has_query: boolean
  body_kept: boolean
  error: string | null
  graphql: {
    operation: string | null
    kind: string | null
    depth: number | null
    selections: number | null
    errors: number | null
  } | null
  matched_by: string | null
}

export interface StoryCaller {
  kind: 'user' | 'api_key' | 'anonymous'
  label: string
  user_id: string | null
  api_key_id: number | null
  auth: string | null
  mcp: {
    conn: string | null
    client: string | null
    tool: string | null
    outcome: string | null
  } | null
}

export type PhaseCategory = 'auth' | 'access' | 'hooks' | 'work'

export interface StoryPhase {
  seq: number
  phase: string
  /** The phase in words ("Hook efp-ops:forecast-guard", "Permissions"). */
  label: string
  category: PhaseCategory
  at: number
  ms: number
  /** Nesting by containment (a span inside the one before it is its child). */
  depth: number
  detail: string | null
  queries: number | null
  repeat: { sql: string; n: number; ms: number } | null
  wide: Array<{ table: string; n: number }>
}

export interface StoryStatement {
  /** Position in the kept trace's top_sql (POST /traces/:id/explain takes it). */
  index: number
  sql: string
  n: number
  ms: number
  avg_ms: number
  /** Share of the request's SQL wait, 0..1. */
  share: number
  sha: string | null
  tables: string[]
  select: boolean
  truncated: boolean
  /** Ran over and over inside one phase (an N+1). */
  repeat_n: number | null
  /** `select *` on a table with a long-text column. */
  wide: boolean
}

export interface StoryTraceDetail {
  total_ms: number
  queries: number
  sql_ms: number
  /** Time no measured phase covers (handler code, serialization, waiting). */
  unaccounted_ms: number
  /** Top-level time by category; `unmeasured` = unaccounted_ms. Sums to total_ms. */
  split: Array<{ key: PhaseCategory | 'unmeasured'; label: string; ms: number }>
  phases: StoryPhase[]
  statements: StoryStatement[]
  wide: Array<{ table: string; n: number }>
}

export type EffectKind =
  | 'write'
  | 'transition'
  | 'flow'
  | 'push'
  | 'attempt'
  | 'call'
  | 'notify'
  | 'mail'
  | 'other'

/** One thing the request wrote or set off — ids to open it, never field values or bodies. */
export interface StoryEffect {
  key: string
  parent: string | null
  kind: EffectKind
  at: string | null
  offset_ms: number | null
  who: string | null
  record: { collection: string; item: string; label?: string | null } | null
  summary: string
  failed: boolean
  reason: string | null
  facts: EffectFacts
}

export interface EffectFacts {
  /** The row behind the step: activity / history / flow run / submission / attempt / call /
   *  notification / mail-log id. */
  id?: number | null
  action?: 'create' | 'update' | 'delete' | null
  fields?: Array<{ field: string; label: string }>
  from?: string | null
  to?: string | null
  flow_id?: string | null
  status?: string | null
  halted_at?: string | null
  error?: string | null
  submission_id?: number | null
  api_id?: number | null
  attempts?: number | null
  http_status?: number | null
  method?: string | null
  url?: string | null
  duration_ms?: number | null
  recipient?: string | null
  recipient_id?: string | null
  category?: string | null
  lane?: string | null
  channels?: Array<{ channel: string; status: string; reason?: string | null }>
  template?: string | null
  recipients?: number | null
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
        ? `Created ${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun}`
        : m === 'GET'
          ? `Listed ${col.replace(/_/g, ' ')}`
          : `${m} ${col}`
    if (m === 'PATCH' || m === 'PUT') return `Saved ${noun} ${id}`
    if (m === 'DELETE') return `Deleted ${noun} ${id}`
    if (m === 'GET') return `Opened ${noun} ${id}`
  }
  const named = /\/(?:workflows|pipelines)\/instance\/([A-Za-z0-9_]+)\/([^/?#]+)\/transition$/.exec(
    path
  )
  if (named && m === 'POST') return `Moved ${nounOf(named[1])} ${named[2]} along its pipeline`
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
    missing,
    request: log ? storyRequest(log, startMs) : null,
    caller: log ? storyCaller(log) : null,
    trace: trace ? storyTraceDetail(trace) : null,
    effects: steps
      .filter((st) => st.kind !== 'request')
      .map((st) => storyEffect(st, offsetOf(st.at)))
      // Stable: steps keep the loader's order within the same instant.
      .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))
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

// ─── v2: the drill-down parts ────────────────────────────────────────────────

/** Which bucket of the time split a phase belongs to. */
export function phaseCategory(phase: string): PhaseCategory {
  if (phase === 'auth' || phase.startsWith('auth:')) return 'auth'
  if (/^(permissions|metadata|tree-permissions|row-locks|section-locks|read-gate)\b/.test(phase))
    return 'access'
  if (/^(hook:|hooks:|rules:|row-rules|field-rules)/.test(phase)) return 'hooks'
  return 'work'
}

/** A phase in words: "Hook efp-ops:forecast-guard", "Sign-in check", "Queue · sla". */
export function phaseLabel(phase: string, detail?: string | null): string {
  if (phase.startsWith('hook:')) return `Hook ${hookName(phase, detail ?? undefined)}`
  if (phase === 'auth') return 'Sign-in check'
  const words = phase
    .split(':')
    .map((p) => p.replace(/[-_]+/g, ' ').trim())
    .filter(Boolean)
    .join(' · ')
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : phase
}

/** Below this much slack a span counts as inside the one before it. */
const SLACK_MS = 0.5

/** Spans in start order, each with its nesting depth (a span inside the one before is its child). */
export function layoutPhases(spans: StoryTraceSpan[]): StoryPhase[] {
  const sorted = spans
    .map((s, i) => ({ s, seq: s.seq ?? i }))
    .sort((a, b) => a.s.at - b.s.at || b.s.ms - a.s.ms)
  const stack: StoryTraceSpan[] = []
  return sorted.map(({ s, seq }) => {
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (s.at >= top.at - SLACK_MS && s.at + s.ms <= top.at + top.ms + SLACK_MS) break
      stack.pop()
    }
    const depth = stack.length
    stack.push(s)
    return {
      seq,
      phase: s.phase,
      label: phaseLabel(s.phase, s.detail),
      category: phaseCategory(s.phase),
      at: Math.max(0, Math.round(s.at * 10) / 10),
      ms: Math.round(s.ms * 10) / 10,
      depth,
      detail: s.detail?.trim() ? s.detail.trim() : null,
      queries: s.queries ?? null,
      repeat: s.repeat ?? null,
      wide: s.wide ?? []
    }
  })
}

const SPLIT_LABEL: Record<PhaseCategory | 'unmeasured', string> = {
  auth: 'Sign-in',
  access: 'Access checks',
  hooks: 'Hooks & rules',
  work: 'Other measured work',
  unmeasured: 'Not measured'
}

/** Time no top-level span covers — request-trace.ts unaccountedMs over the same spans. */
export function unmeasuredMs(phases: StoryPhase[], total: number): number {
  const covered = phases.filter((p) => p.depth === 0).reduce((n, p) => n + p.ms, 0)
  return Math.max(0, Math.round(total - covered))
}

/** Top-level time by category, then what nothing measured. Zero buckets are left out. */
export function timeSplit(phases: StoryPhase[], total: number): StoryTraceDetail['split'] {
  const sums: Record<PhaseCategory, number> = { auth: 0, access: 0, hooks: 0, work: 0 }
  for (const p of phases) if (p.depth === 0) sums[p.category] += p.ms
  const out: StoryTraceDetail['split'] = (['auth', 'access', 'hooks', 'work'] as const)
    .filter((k) => sums[k] > 0)
    .map((k) => ({ key: k, label: SPLIT_LABEL[k], ms: Math.round(sums[k]) }))
  const rest = unmeasuredMs(phases, total)
  if (rest > 0) out.push({ key: 'unmeasured', label: SPLIT_LABEL.unmeasured, ms: rest })
  return out
}

const WIDE_SELECT = /^\s*select\s+(?:top\s*\(?[@\w]+\)?\s+)?\*\s+from\s+\[?([A-Za-z0-9_]+)\]?/i

/** The kept statements with what a reader needs to judge them. TEXT only, never bindings. */
export function storyStatements(trace: StoryTrace): StoryStatement[] {
  const totalMs = Math.max(
    trace.sql_ms,
    trace.top_sql.reduce((n, s) => n + s.ms, 0),
    1
  )
  const wideTables = new Set((trace.wide ?? []).map((w) => w.table.toLowerCase()))
  return trace.top_sql.map((s, index) => {
    let repeat: number | null = null
    for (const sp of trace.spans)
      if (sp.repeat && sp.repeat.sql === s.sql) repeat = Math.max(repeat ?? 0, sp.repeat.n)
    const m = WIDE_SELECT.exec(s.sql)
    return {
      index,
      sql: s.sql,
      n: s.n,
      ms: Math.round(s.ms),
      avg_ms: s.n > 0 ? Math.round((s.ms / s.n) * 10) / 10 : Math.round(s.ms),
      share: Math.min(1, Math.max(0, s.ms / totalMs)),
      sha: s.sha ?? null,
      tables: s.tables ?? [],
      select: /^\s*select\b/i.test(s.sql),
      truncated: s.sql.endsWith('…'),
      repeat_n: repeat,
      wide: !!m && wideTables.has(m[1].toLowerCase())
    }
  })
}

export function storyTraceDetail(trace: StoryTrace): StoryTraceDetail {
  const phases = layoutPhases(trace.spans)
  return {
    total_ms: Math.round(trace.total_ms),
    queries: trace.queries,
    sql_ms: Math.round(trace.sql_ms),
    unaccounted_ms: unmeasuredMs(phases, trace.total_ms),
    split: timeSplit(phases, trace.total_ms),
    phases,
    statements: storyStatements(trace),
    wide: trace.wide ?? []
  }
}

const EFFECT_KIND: Record<string, EffectKind> = {
  write: 'write',
  transition: 'transition',
  flow: 'flow',
  push: 'push',
  attempt: 'attempt',
  partner_call: 'call',
  notify: 'notify',
  mail: 'mail'
}

const numOr = (v: unknown): number | null =>
  v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v)
const strOr = (v: unknown): string | null => (v == null || v === '' ? null : String(v))

/** The row id a step key names (`activity:12` → 12). */
export function stepRowId(key: string): number | null {
  const cut = key.lastIndexOf(':')
  return cut >= 0 ? numOr(key.slice(cut + 1)) : null
}

/** One chain step → an effect with the ids that open it. Field NAMES only, never values. */
export function storyEffect(step: StoryStep, offset: number | null): StoryEffect {
  const kind = EFFECT_KIND[step.kind] ?? 'other'
  const d = (step.detail ?? {}) as Record<string, unknown>
  const facts: EffectFacts = { id: stepRowId(step.key) }
  switch (kind) {
    case 'write': {
      const s = step.summary.trim().toLowerCase()
      facts.action = s.startsWith('created')
        ? 'create'
        : s.startsWith('deleted')
          ? 'delete'
          : s.startsWith('updated')
            ? 'update'
            : null
      if (d.type === 'changes' && Array.isArray(d.changes))
        facts.fields = (d.changes as Array<{ field?: unknown; label?: unknown }>)
          .filter((c) => c && (c.field || c.label))
          .map((c) => ({ field: String(c.field ?? c.label), label: String(c.label ?? c.field) }))
      break
    }
    case 'transition':
      facts.from = strOr(d.from)
      facts.to = strOr(d.to)
      break
    case 'flow':
      facts.flow_id = strOr(d.flow_id)
      facts.status = strOr(d.status)
      facts.halted_at = strOr(d.halted_at)
      facts.error = strOr(d.error)
      break
    case 'push':
      facts.submission_id = numOr(d.submission_id) ?? facts.id
      facts.api_id = step.api_id ?? null
      facts.status = strOr(d.status)
      facts.attempts = numOr(d.attempts)
      facts.http_status = numOr(d.http_status)
      facts.error = strOr(d.error)
      break
    case 'attempt': {
      const parent = step.parent ?? ''
      facts.submission_id = parent.startsWith('submission:') ? stepRowId(parent) : null
      break
    }
    case 'call':
      facts.api_id = step.api_id ?? null
      facts.method = strOr(d.method)
      facts.url = strOr(d.url)
      facts.http_status = numOr(d.status)
      facts.duration_ms = numOr(d.duration_ms)
      facts.error = strOr(d.error)
      break
    case 'notify':
      facts.recipient = strOr(d.recipient)
      facts.recipient_id = strOr(d.recipient_id)
      facts.category = strOr(d.category)
      facts.lane = strOr(d.lane)
      facts.channels = Array.isArray(d.channels)
        ? (d.channels as Array<{ channel?: unknown; status?: unknown; reason?: unknown }>).map(
            (c) => ({
              channel: String(c.channel ?? ''),
              status: String(c.status ?? ''),
              reason: strOr(c.reason)
            })
          )
        : []
      break
    case 'mail':
      facts.id = numOr(d.mail_log_id) ?? facts.id
      facts.status = strOr(d.status)
      facts.template = strOr(d.template)
      facts.recipients = numOr(d.recipients)
      facts.error = strOr(d.error)
      break
  }
  return {
    key: step.key,
    parent: step.parent ?? null,
    kind,
    at: step.at ?? null,
    offset_ms: offset,
    who: step.who ?? null,
    record: step.record ?? null,
    summary: step.summary,
    failed: !!step.failed,
    reason: step.reason ?? null,
    facts
  }
}

export function storyRequest(log: StoryLog, startMs: number | null): StoryRequest {
  return {
    method: log.method,
    path: log.path,
    route: log.route,
    status: log.status,
    started_at: startMs != null ? new Date(startMs).toISOString() : null,
    finished_at: log.created_at,
    latency_ms: log.latency_ms,
    instance: log.instance,
    auth: log.auth ?? null,
    ip: log.ip ?? null,
    user_agent: log.user_agent ?? null,
    has_query: !!log.has_query,
    body_kept: !!log.body_kept,
    error: log.error,
    graphql:
      log.graphql || log.graphql_operation
        ? {
            operation: log.graphql_operation,
            kind: log.graphql?.kind ?? null,
            depth: log.graphql?.depth ?? null,
            selections: log.graphql?.selections ?? null,
            errors: log.graphql?.errors ?? null
          }
        : null,
    matched_by: log.matched_by ?? null
  }
}

export function storyCaller(log: StoryLog): StoryCaller {
  return {
    kind: log.caller_kind,
    label:
      log.who ??
      (log.caller_kind === 'anonymous'
        ? 'Someone not signed in'
        : log.caller_kind === 'api_key'
          ? 'An API key'
          : 'A person'),
    user_id: log.user_id ?? null,
    api_key_id: log.api_key_id ?? null,
    auth: log.auth ?? null,
    mcp: log.mcp ?? null
  }
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
