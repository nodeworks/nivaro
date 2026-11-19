/**
 * Request story (#19) — reads the parts request-story.ts assembles:
 *
 *  - the API log row by request_id (traffic-inspect/request.ts findRequestRow, migration 389);
 *  - the kept trace from this process's ring (request-trace.ts getTrace — per process, so a
 *    request another replica served has none here, and fast requests are never kept);
 *  - the integration chain the request started (api_logs.chain_id → every row stamped with it:
 *    activity, workflow history, flow runs, pushes, partner calls, notifications, mail —
 *    event-path/exact.ts loadChainSteps, bodies OFF).
 *
 * Activity rows carry no request_id column; they are joined through the chain id the request
 * stamped on them (migration 351), which every /api request opens.
 */
import { loadChainSteps } from './event-path/exact.js'
import { redactError } from './event-path/redact.js'
import {
  assembleRequestStory,
  type RequestStory,
  type StoryLog,
  type StoryParts,
  type StoryStep,
  type StoryTrace
} from './request-story.js'
import { getTrace, type TraceRecord } from './request-trace.js'
import {
  findRequestRow,
  LOG_RETENTION_DAYS,
  PENDING_MS,
  type RequestRow,
  traceAbsence
} from './traffic-inspect/request.js'
import { statementSha, statementTables } from './traffic-inspect/request-logic.js'

function storyLog(row: RequestRow, matchedBy: string | null): StoryLog {
  return {
    method: row.method,
    path: row.path.split('?')[0],
    route: row.route,
    status: row.status,
    latency_ms: row.latency_ms,
    created_at: row.created_at,
    who: row.caller.kind === 'anonymous' ? null : row.caller.label,
    caller_kind: row.caller.kind,
    instance: row.instance,
    chain_id: row.chain_id,
    error: redactError(row.error, false),
    graphql_operation: row.graphql?.operation ?? null,
    auth: row.auth,
    user_id: row.user,
    api_key_id: row.api_key_id,
    ip: row.ip,
    user_agent: row.user_agent,
    // The query string and a kept body are values: the story says they exist, never what.
    has_query: !!row.query,
    body_kept: row.body_source === 'log',
    graphql: row.graphql
      ? {
          kind: row.graphql.kind,
          depth: row.graphql.depth,
          selections: row.graphql.selections,
          errors: row.graphql.errors
        }
      : null,
    mcp: row.mcp,
    matched_by: matchedBy
  }
}

/** Only what the story shows: phase names/timings, statement TEXT (never bindings), emit names. */
function storyTrace(t: TraceRecord): StoryTrace {
  return {
    total_ms: t.total_ms,
    queries: t.queries,
    sql_ms: t.sql_ms,
    spans: t.spans.map((s) => ({
      seq: s.seq,
      phase: s.phase,
      ms: s.ms,
      at: s.at,
      ...(s.detail ? { detail: s.detail } : {}),
      ...(s.queries ? { queries: s.queries } : {}),
      // The repeated statement's TEXT (never its bindings).
      ...(s.repeat ? { repeat: { sql: s.repeat.sql, n: s.repeat.n, ms: s.repeat.ms } } : {}),
      ...(s.wide?.length ? { wide: s.wide } : {})
    })),
    top_sql: t.top_sql.map((s) => ({
      sql: s.sql,
      n: s.n,
      ms: s.ms,
      sha: statementSha(s.sql),
      tables: statementTables(s.sql)
    })),
    wide: t.wide ?? [],
    ...(t.emits ? { emits: t.emits } : {})
  }
}

/** Write details keep field NAMES only — the old/new values never leave this function. */
export function storyStep(s: {
  key: string
  parent?: string | null
  kind: string
  at: string
  who?: string | null
  record?: { collection: string; item: string; label?: string | null } | null
  summary: string
  failed?: boolean
  reason?: string | null
  detail?: unknown
  api_id?: number | null
}): StoryStep {
  const d = s.detail as Record<string, unknown> | null | undefined
  let detail: Record<string, unknown> | null = null
  if (d?.type === 'changes' && Array.isArray(d.changes)) {
    detail = {
      type: 'changes',
      changes: (d.changes as Array<{ field?: string; label?: string }>).map((c) => ({
        field: c.field,
        label: c.label
      }))
    }
  } else if (d?.type === 'call') {
    // url is scheme + host + path (redactUrl without bodies): no query values.
    detail = {
      type: 'call',
      method: d.method ?? null,
      url: d.url ?? null,
      status: d.status ?? null,
      duration_ms: d.duration_ms ?? null,
      error: d.error ?? null
    }
  } else if (d?.type === 'push') {
    detail = {
      type: 'push',
      status: d.status,
      http_status: d.http_status ?? null,
      attempts: d.attempts ?? null,
      error: d.error ?? null,
      submission_id: d.submission_id ?? null
    }
  } else if (d?.type === 'notify') {
    // Never the subject line — another person's inbox.
    detail = {
      type: 'notify',
      recipient: d.recipient,
      recipient_id: d.recipient_id ?? null,
      category: d.category ?? null,
      lane: d.lane ?? null,
      channels: Array.isArray(d.channels) ? d.channels : []
    }
  } else if (d?.type === 'transition') {
    // From / to step names; the comment is a person's words and stays on the record.
    detail = { type: 'transition', from: d.from ?? null, to: d.to ?? null }
  } else if (d?.type === 'flow') {
    detail = {
      type: 'flow',
      flow_id: d.flow_id ?? null,
      status: d.status ?? null,
      halted_at: d.halted_at ?? null,
      error: d.error ?? null
    }
  } else if (d?.type === 'mail') {
    // Never the subject or the addresses.
    detail = {
      type: 'mail',
      status: d.status ?? null,
      template: d.template ?? null,
      recipients: d.recipients ?? null,
      mail_log_id: d.mail_log_id ?? null,
      error: d.error ?? null
    }
  }
  return {
    key: s.key,
    parent: s.parent ?? null,
    api_id: s.api_id ?? null,
    kind: s.kind,
    at: s.at,
    who: s.who ?? null,
    record: s.record ?? null,
    summary: s.summary,
    failed: !!s.failed,
    reason: s.reason ?? null,
    detail
  }
}

export async function loadRequestStory(requestId: string): Promise<RequestStory> {
  const parts: StoryParts = { requestId, log: null, trace: null, steps: null }

  let row: RequestRow | null = null
  let matchedBy: string | null = null
  try {
    const found = await findRequestRow(requestId, null)
    row = found?.row ?? null
    matchedBy = found?.matched_by ?? null
  } catch {
    parts.logReason = 'The API log could not be read just now.'
  }
  if (row) parts.log = storyLog(row, matchedBy)

  const trace = getTrace(requestId)
  if (trace) {
    parts.trace = storyTrace(trace)
  } else {
    parts.traceReason = traceAbsence(row).reason
  }

  if (!row) {
    // A kept trace dates the request: young enough = the logger's batch has not flushed yet.
    const at = trace ? Date.parse(trace.ts) : Number.NaN
    if (Number.isFinite(at) && Date.now() - at < PENDING_MS) parts.logPending = true
    else if (!parts.logReason)
      parts.logReason = `No API log row has this request id — the log keeps ${LOG_RETENTION_DAYS} days, and requests outside /api (or inner dispatches) have none.`
  }

  if (row?.chain_id) {
    try {
      const chain = await loadChainSteps(row.chain_id, { withBodies: false })
      parts.steps = chain.steps.map(storyStep)
      parts.stepWarnings = chain.warnings.map((w) => w.split(':')[0])
    } catch {
      parts.steps = null
    }
  }
  return assembleRequestStory(parts)
}
